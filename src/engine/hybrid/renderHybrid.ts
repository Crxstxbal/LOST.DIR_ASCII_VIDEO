import { applyPost, composeAscii } from '../ascii/AsciiCompositor';
import { getGlyphSet } from '../ascii/GlyphSet';
import { evalCamera, type SubjectTrack, type View } from '../camera/Camera';
import { createCanvas, ctx2d, type CanvasLike } from '../core/canvasFactory';
import { hexToRgb, resolvePalette, type RGB } from '../core/color';
import { clamp, easeInOut, smoothstep } from '../core/math';
import { computeLod, smoothedRows, type CharacterLod } from '../character/lod';
import { evalGrade, makeGrader } from '../grading/ColorGrade';
import { DEFAULT_HYBRID_FX, resolveAscii, type Project, type Shot } from '../project/schema';
import { getLocation } from '../scene/registry';
import { makeWind } from '../scene/wind';
import type { Painter } from '../raster/Painter';
import { actorWorld, gridFor, painterFor, resolveLook, runtimeFor, shotSeed, VIRTUAL_W, type RenderOptions, type RenderResult } from '../render';
import { Camera3D } from './camera3d';
import { gbufferFor, type GBuffer } from './gbuffer';
import { StrokeBuffer, drawStrokes } from './glyphStrokes';
import { lightGBuffer, type HybridLight, type ShadowCaster } from './lighting';
import { bloom } from './post';
import { drawRidges, drawTerrain, heightAt, type TerrainParams } from './terrain';
import { drawVegetation, type VegColors, type VegParams } from './vegetation';
import redFieldDef from '../../../data/locations/red_field.json';

/**
 * HYBRID ASCII renderer (experimental; coexists with LEGACY).
 *
 *   camera (3D, same framing as LEGACY at yaw 0) → G-buffer at shape-zone resolution
 *   (sky, terrain mesh, ridges, instanced roses) → deferred light + shadow + fog →
 *   raster with the existing character composited by depth → composeAscii (same grid,
 *   same glyph matching as LEGACY) → world-anchored free glyphs for vegetation →
 *   bloom + the usual post. Deterministic: a pure function of (project, shot, t).
 */
const strokePool = new Map<number, StrokeBuffer>();
function strokesFor(cap: number) {
  let s = strokePool.get(cap);
  if (!s) {
    s = new StrokeBuffer(cap);
    strokePool.set(cap, s);
  }
  s.reset();
  return s;
}

interface Scratch {
  imgC: ImageData;
  imgD: ImageData;
  fgC: CanvasLike;
  fgD: CanvasLike;
  fgImgC: ImageData;
  fgImgD: ImageData;
}
const scratch = new Map<string, Scratch>();
function scratchFor(P: Painter): Scratch {
  const k = `${P.w}x${P.h}`;
  let s = scratch.get(k);
  if (!s) {
    const fgC = createCanvas(P.w, P.h);
    const fgD = createCanvas(P.w, P.h);
    s = {
      imgC: P.cc.createImageData(P.w, P.h),
      imgD: P.dc.createImageData(P.w, P.h),
      fgC,
      fgD,
      fgImgC: ctx2d(fgC).createImageData(P.w, P.h),
      fgImgD: ctx2d(fgD).createImageData(P.w, P.h),
    };
    scratch.set(k, s);
  }
  return s;
}

const rgb = (h: string): RGB => hexToRgb(h);

/** The HYBRID world description of a location (red_field's when the location has none). */
function worldOf(locId: string) {
  return getLocation(locId).hybrid ?? (redFieldDef as any).hybrid;
}

export function terrainParamsFor(project: Project, shot: Shot): TerrainParams {
  const loc = getLocation(shot.location);
  const W = worldOf(shot.location);
  const params = { ...loc.params, ...shot.locationParams } as Record<string, number>;
  return {
    relief: (W.terrain.relief ?? 1) * (params.relief ?? 1),
    pathZ: shot.actor ? shot.actor.lane : W.terrain.pathZ ?? 0,
    seed: shotSeedWorld(project),
    soil: rgb(W.terrain.soil),
    undergrowth: rgb(W.terrain.undergrowth),
    far: rgb(W.terrain.far),
  };
}

/** The world (terrain, roses) is shared by all shots of a project: seeded by the project, not the shot. */
function shotSeedWorld(project: Project) {
  return (project.seed * 7 + 1013) >>> 0;
}

/** 3D camera of a HYBRID shot at time t (rides the terrain; 'overhead' is a true top-down view). */
export function hybridCamera(shot: Shot, subject: SubjectTrack | null, t: number, VW: number, VH: number, T: TerrainParams): { cam: Camera3D; view: View } {
  const view = evalCamera(shot.camera, subject, t, shot.duration, VW, VH);
  const c = shot.camera;
  const fx = view.cx - c.offsetX - c.moveX * easeInOut(clamp(t / shot.duration));
  const fz = view.cz + c.distance;
  const ground = heightAt(T, fx, fz);
  if (c.type === 'overhead') {
    const pitch = c.aim?.pitch ?? 1.48;
    const y = ground + c.height + c.moveY * easeInOut(clamp(t / shot.duration));
    const back = (y - ground) / Math.tan(pitch);
    const cam = new Camera3D({ vw: VW, vh: VH, py: VH / 2, f: view.f, pos: [view.cx, y, fz - back], yaw: c.aim?.yaw ?? 0, pitch });
    return { cam, view };
  }
  const base = Camera3D.fromView(view, c.aim);
  const cam = new Camera3D({ vw: VW, vh: VH, py: view.py, f: view.f, pos: [view.cx, view.cy + ground, view.cz], yaw: base.yaw, pitch: base.pitch });
  return { cam, view };
}

export function renderHybrid(project: Project, shotIndex: number, t: number, opts: RenderOptions): RenderResult {
  const pf = opts.profile;
  const tStart = pf ? performance.now() : 0;
  let tMark = tStart;
  const lap = (k: string) => {
    if (!pf) return;
    const n = performance.now();
    pf[k] = (pf[k] ?? 0) + n - tMark;
    tMark = n;
  };
  const shot = project.shots[shotIndex];
  const W = Math.round(opts.width);
  const H = Math.round(opts.height);
  const VW = VIRTUAL_W;
  const VH = (VIRTUAL_W * H) / W;
  const loc = getLocation(shot.location);
  const world = worldOf(shot.location);
  const params = { ...loc.params, ...shot.locationParams } as Record<string, number>;
  const seed = shotSeed(project, shot);
  const wseed = shotSeedWorld(project);
  const palette = resolvePalette(project.palette);
  const grade = evalGrade(shot.grade, shot.gradeKeys, t);
  const A = resolveAscii(project, shot);
  const fx = { ...DEFAULT_HYBRID_FX, ...(project.output.hybrid ?? {}) };
  const cols0 = Math.max(40, Math.round(A.cols * (opts.colsScale ?? 1)));
  const grid = gridFor(cols0, W, H);
  const T = terrainParamsFor(project, shot);
  const rt = runtimeFor(project, shot);
  const { cam, view } = hybridCamera(shot, rt?.subject ?? null, t, VW, VH, T);
  const wind = makeWind(shot.wind, wseed);
  lap('hybrid: cámara');

  // ---- light & atmosphere ----
  const az = params.lightAzimuth ?? 0.45;
  const el = params.lightElevation ?? 0.16;
  const Lt: HybridLight = {
    L: [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)],
    key: rgb(world.light.key),
    keyI: world.light.keyI * (params.keyLight ?? 1),
    ambient: rgb(world.light.ambient),
    ambientI: world.light.ambientI,
    rim: world.light.rim,
    zenith: rgb(world.sky.zenith),
    horizon: rgb(world.sky.horizon),
    glow: rgb(world.sky.glow),
    clouds: world.sky.clouds * (params.cloudCover !== undefined ? params.cloudCover / 0.42 : 1),
    cloudSpeed: world.sky.cloudSpeed,
    fog: rgb(world.fog.color),
    fogDensity: world.fog.density * (params.fogDensity !== undefined ? params.fogDensity / 0.8 : 1),
    fogHeight: world.fog.height,
    seed: wseed,
  };

  // ---- G-buffer: terrain, ridges ----
  const P = painterFor(grid.cols, grid.rows, VW, VH, 'hyb');
  const G = gbufferFor(P.w, P.h);
  const tris = drawTerrain(G, cam, T, 6, 900) + drawRidges(G, cam, T, world.ridges.map((r: any) => ({ dist: r.dist, height: r.height * (params.ridgeHeight !== undefined ? params.ridgeHeight / 0.5 : 1) })));
  lap('hybrid: terreno');

  // ---- actor (placement, LOD, wake) ----
  let actor: { x: number; y: number; z: number; depth: number; scrX: number; scrY: number; s: number; vk: number; elev: number; lod: CharacterLod } | null = null;
  const trail: { x: number; z: number }[] = [];
  let headScr: RenderResult['head'];
  if (rt && shot.actor) {
    rt.sim.ensure(t);
    const pose = rt.sim.pose;
    const w = actorWorld(shot.actor, pose.u);
    const ay = heightAt(T, w.x, w.z);
    const p = cam.project(w.x, ay, w.z);
    const head = cam.project(w.x, ay + 1.7, w.z);
    for (let k = 0; k < 6; k++) trail.push(k === 0 ? w : rt.subject.pos(Math.max(-1.5, t - k * 0.22)));
    if (p && head) {
      const cellH = VH / grid.rows;
      const sub = rt.subject;
      const rows = smoothedRows((dt) => {
        if (dt > 0 && t - dt < 0) return null;
        const c2 = dt === 0 ? cam : hybridCamera(shot, sub, t - dt, VW, VH, T).cam;
        const q = dt === 0 ? w : sub.pos(t - dt);
        const qy = heightAt(T, q.x, q.z);
        const a = c2.project(q.x, qy, q.z);
        const b = c2.project(q.x, qy + 1.7, q.z);
        if (!a || !b) return null;
        return (0.25 * (a.y - b.y)) / 1.7 / cellH;
      });
      const vk = clamp((p.y - head.y) / (1.7 * p.s), 0.4, 1.2);
      actor = {
        x: w.x,
        y: ay,
        z: w.z,
        depth: p.depth,
        scrX: p.x,
        scrY: p.y,
        s: p.s,
        vk,
        elev: Math.atan2(cam.pos[1] - (ay + 1), Math.max(0.1, p.depth)),
        lod: computeLod(rows, A.autoLod),
      };
      const k = W / VW;
      headScr = { x: head.x * k, y: head.y * k, s: p.s * k };
    }
  }

  // ---- vegetation (G-buffer mass + free glyphs) ----
  const S = strokesFor(9000);
  const vegP: VegParams = {
    density: world.vegetation.density * (params.roseDensity ?? 1),
    far: world.vegetation.far,
    height: world.vegetation.height * (params.roseHeight ?? 1),
    blades: world.vegetation.blades * (params.blades ?? 1),
    petals: world.vegetation.petals * (params.petals ?? 1),
    strokes: fx.strokes,
  };
  const colors: VegColors = {
    flowers: world.colors.flowers.map(rgb),
    stem: rgb(world.colors.stem),
    leaf: rgb(world.colors.leaf),
    blades: world.colors.blades.map(rgb),
  };
  const veg = drawVegetation({ G, cam, T, P: vegP, wind, t, trail, S, seed: wseed, colors, Lt, fog: fx.fog, cols: grid.cols, rows: grid.rows });
  lap('hybrid: vegetación');

  // ---- deferred light, shadow, fog ----
  const caster: ShadowCaster | null = actor ? { x: actor.x, y: actor.y, z: actor.z, len: clamp(1.7 / Math.tan(Math.max(0.12, el)), 1.2, 7), width: 0.3 } : null;
  lightGBuffer(G, cam, Lt, t, caster, fx);
  lap('hybrid: luz y niebla');

  // ---- raster: background, character, foreground (depth-sorted around the actor) ----
  const sc = scratchFor(P);
  writeRaster(G, sc.imgC.data, sc.imgD.data, -1);
  P.cc.putImageData(sc.imgC, 0, 0);
  P.dc.putImageData(sc.imgD, 0, 0);
  let charAlpha: Uint8ClampedArray | null = null;
  if (actor && rt && !opts.hideActor) {
    const Pc = painterFor(grid.cols, grid.rows, VW, VH, 'hybchar');
    // the Painter draws paths with a uniform scale (see shadeFace): pre-divide y so the
    // character lands exactly on its projected position in this geometrically exact raster
    const ry = (Pc.k * Pc.vh) / Pc.h;
    const look = resolveLook(project, shot.actor!.character);
    const facing = rt.sim.view === 'side' && shot.actor!.heading === 'left' ? -1 : 1;
    const side = Math.sign(Lt.L[0] * cam.R[0] + Lt.L[2] * cam.R[2]) || -1;
    rt.renderer.draw(
      Pc,
      rt.sim,
      { x: actor.scrX, y: actor.scrY / ry, s: actor.s, facing, vk: actor.vk / ry, elev: actor.elev, alpha: 1, lod: actor.lod },
      { side, rim: loc.light.rim, rimColor: Lt.glow, ambient: Lt.ambient, ambientAmt: loc.light.ambientAmt },
      seed,
      look.face,
    );
    composite(P, Pc.colorCanvas, Pc.densCanvas);
    charAlpha = Pc.cc.getImageData(0, 0, Pc.w, Pc.h).data;
    // foreground: everything nearer than the actor goes back on top of it
    if (writeRaster(G, sc.fgImgC.data, sc.fgImgD.data, actor.depth - 0.08)) {
      ctx2d(sc.fgC).putImageData(sc.fgImgC, 0, 0);
      ctx2d(sc.fgD).putImageData(sc.fgImgD, 0, 0);
      composite(P, sc.fgC, sc.fgD);
    }
  }
  lap('hybrid: personaje');

  // ---- ASCII conversion (same grid and glyph matching as LEGACY) ----
  const glyphs = getGlyphSet(A.charset);
  const data = new Uint8ClampedArray(W * H * 4);
  const grader = makeGrader(grade, palette);
  const tc0 = performance.now();
  composeAscii(data, [{ painter: P, glyphs, occlude: 0, densityGain: A.density, colorGain: 1 }], {
    width: W,
    height: H,
    vw: VW,
    vh: VH,
    bg: palette.black,
    bgGlow: A.bgGlow,
    dither: A.dither,
    grade: grader,
    lights: [],
    glyphGain: A.glyphGain,
    contrast: A.contrast,
    sharpness: A.sharpness,
  });
  const convMs = performance.now() - tc0;
  lap('ascii: conversión');

  // ---- free glyphs (vegetation / particles) ----
  const zx = G.w / VW;
  const zy = G.h / VH;
  const drawn = drawStrokes(data, S, getGlyphSet('completo'), {
    W,
    H,
    vw: VW,
    vh: VH,
    cols: grid.cols,
    rows: grid.rows,
    grade: grader,
    glyphGain: A.glyphGain,
    occluded: (vx, vy, depth) => {
      const x = Math.floor(vx * zx);
      const y = Math.floor(vy * zy);
      if (x < 0 || y < 0 || x >= G.w || y >= G.h) return true;
      const i = y * G.w + x;
      if (G.depth[i] < depth * 0.97 - 0.04) return true;
      if (charAlpha && actor && depth > actor.depth && charAlpha[i * 4 + 3] > 90) return true;
      return false;
    },
  });
  lap('hybrid: glifos libres');

  bloom(data, W, H, fx.bloom);
  applyPost(data, W, H, shot.effects, Math.round(t * project.fps) + shotIndex * 100000, seed);
  if (shot.transitionIn.type === 'fade' && shot.transitionIn.duration > 0 && t < shot.transitionIn.duration) {
    const f = smoothstep(0, shot.transitionIn.duration, t);
    for (let i = 0; i < data.length; i += 4) {
      data[i] *= f;
      data[i + 1] *= f;
      data[i + 2] *= f;
    }
  }
  lap('post: bloom, grano, viñeta, fundido');
  const stats = {
    triangles: tris,
    roses: veg.roses,
    blades: veg.blades,
    petals: veg.petals,
    strokes: drawn,
    objects: veg.roses + veg.blades + veg.petals + (actor ? 1 : 0),
    conversionMs: convMs,
  };
  if (pf) {
    pf['TOTAL'] = (pf['TOTAL'] ?? 0) + performance.now() - tStart;
    pf['objetos visibles (cantidad, no ms)'] = (pf['objetos visibles (cantidad, no ms)'] ?? 0) + stats.objects;
  }
  return { data, width: W, height: H, cols: grid.cols, rows: grid.rows, view, head: headScr, lod: actor?.lod, renderer: 'hybrid', stats };
}

/** G-buffer → RGBA colour/density images. nearer < 0: everything; else only pixels nearer than it (others transparent). */
function writeRaster(G: GBuffer, c: Uint8ClampedArray, d: Uint8ClampedArray, nearer: number): boolean {
  let any = false;
  const n = G.w * G.h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (nearer >= 0 && !(G.depth[i] < nearer)) {
      c[o + 3] = 0;
      d[o + 3] = 0;
      continue;
    }
    any = true;
    c[o] = clamp(G.lit[i * 3]) * 255;
    c[o + 1] = clamp(G.lit[i * 3 + 1]) * 255;
    c[o + 2] = clamp(G.lit[i * 3 + 2]) * 255;
    c[o + 3] = 255;
    const v = clamp(G.dens[i]) * 255;
    d[o] = v;
    d[o + 1] = v;
    d[o + 2] = v;
    d[o + 3] = 255;
  }
  return any;
}

function composite(P: Painter, c: CanvasLike, d: CanvasLike) {
  for (const [dst, src] of [
    [P.cc, c],
    [P.dc, d],
  ] as const) {
    dst.save();
    dst.setTransform(1, 0, 0, 1, 0, 0);
    dst.drawImage(src as any, 0, 0);
    dst.restore();
  }
}
