import protagonistJson from '../../data/characters/protagonist.json';
import { applyPost, composeAscii, type PassInput } from './ascii/AsciiCompositor';
import { CELL_ASPECT, getGlyphSet } from './ascii/GlyphSet';
import { evalCamera, type SubjectTrack, type View } from './camera/Camera';
import { hexToRgb, resolvePalette } from './core/color';
import { clamp, smoothstep } from './core/math';
import { hashString } from './core/rng';
import { CharacterSim, type SimView } from './animation/characterSim';
import { buildTrack, sampleTrack, type LocoTrack } from './animation/locomotion';
import { CharacterRenderer } from './character/drawCharacter';
import { computeLod, smoothedRows, type CharacterLod } from './character/lod';
import type { FaceParams } from './character/face';
import type { GaitParams } from './animation/locomotion';
import type { CharacterDef } from './character/types';
import { evalGrade, makeGrader } from './grading/ColorGrade';
import { resolveAscii, type ActorParams, type Project, type Shot } from './project/schema';
import { Painter, SX, SY } from './raster/Painter';
import { getGenerator, getLocation } from './scene/registry';
import { DrawList, type FrameCtx, type PassId } from './scene/types';
import { makeWind } from './scene/wind';

export const VIRTUAL_W = 1920;
const characters: Record<string, CharacterDef> = { protagonist: protagonistJson as unknown as CharacterDef };

/** Effective global look of a character: base look (character file) + project overrides. */
export function resolveLook(project: Project, id: string): { face: Partial<FaceParams>; gait: Partial<GaitParams> } {
  const def = getCharacter(id);
  const o = project.characters?.[id] ?? {};
  return { face: { ...(def.look?.face ?? {}), ...(o.face ?? {}) }, gait: { ...(def.look?.gait ?? {}), ...(o.gait ?? {}) } };
}

export function getCharacter(id: string): CharacterDef {
  return characters[id] ?? characters.protagonist;
}

/** World position of an actor for a given along-path distance u. */
export function actorWorld(a: ActorParams, u: number): { x: number; z: number } {
  switch (a.heading) {
    case 'left':
      return { x: -u, z: a.lane };
    case 'toward':
      return { x: a.lane, z: 2 * a.start - u };
    case 'away':
      return { x: a.lane, z: u };
    default:
      return { x: u, z: a.lane };
  }
}

export function simViewFor(a: ActorParams): SimView {
  return a.heading === 'toward' ? 'front' : a.heading === 'away' ? 'back' : 'side';
}

interface ShotRuntime {
  key: string;
  track: LocoTrack;
  sim: CharacterSim;
  subject: SubjectTrack;
  renderer: CharacterRenderer;
}

const runtimes = new Map<string, ShotRuntime>();

function shotSeed(project: Project, shot: Shot) {
  return (project.seed ^ hashString(shot.id)) >>> 0;
}

/** Simulation runtime per shot, rebuilt only when parameters that affect motion change. */
function runtimeFor(project: Project, shot: Shot): ShotRuntime | null {
  if (!shot.actor) return null;
  // the walk comes from the character's global look, placement/actions from the shot
  const actor: ActorParams = { ...shot.actor, gait: resolveLook(project, shot.actor.character).gait };
  const seed = shotSeed(project, shot);
  const key = JSON.stringify({ a: actor, w: shot.wind, d: shot.duration, seed });
  const cached = runtimes.get(shot.id);
  if (cached && cached.key === key) return cached;
  const def = getCharacter(actor.character);
  const track = buildTrack(def, actor, shot.duration);
  const wind = makeWind(shot.wind, seed);
  const view = simViewFor(actor);
  const sign = actor.heading === 'left' ? -1 : 1;
  const z0 = actorWorld(actor, actor.start).z;
  const simWind = (t: number, x: number, y: number) => {
    if (view === 'side') return sign * wind(t, sign * x, y, z0);
    return wind(t, x, y, z0);
  };
  const sim = new CharacterSim(def, track, view, simWind, seed);
  const subject: SubjectTrack = {
    pos: (t: number) => actorWorld(actor, sampleTrack(track, t).dist),
    aimY: 1.0,
  };
  const rt = { key, track, sim, subject, renderer: new CharacterRenderer(def) };
  runtimes.set(shot.id, rt);
  if (runtimes.size > 24) runtimes.delete(runtimes.keys().next().value!);
  return rt;
}

export function projectDuration(p: Project) {
  return p.shots.reduce((a, s) => a + s.duration, 0);
}

/** Map global timeline time to (shot index, local time). */
export function shotAt(p: Project, T: number): { index: number; t: number; start: number } {
  let acc = 0;
  for (let i = 0; i < p.shots.length; i++) {
    const d = p.shots[i].duration;
    if (T < acc + d || i === p.shots.length - 1) return { index: i, t: clamp(T - acc, 0, d), start: acc };
    acc += d;
  }
  return { index: 0, t: 0, start: 0 };
}

export function gridFor(cols: number, W: number, H: number) {
  const rows = Math.max(8, Math.round((H * CELL_ASPECT * cols) / W));
  return { cols, rows };
}

const painters = new Map<string, Painter>();
/** Pooled painters (rasters are reused across frames); `tag` separates passes sharing a grid. */
function painterFor(cols: number, rows: number, vw: number, vh: number, tag = '') {
  const k = `${tag}:${cols}x${rows}x${vw}x${vh}`;
  let p = painters.get(k);
  if (!p) {
    p = new Painter(cols, rows, vw, vh);
    painters.set(k, p);
    if (painters.size > 16) painters.delete(painters.keys().next().value!);
  }
  p.reset();
  return p;
}

/**
 * Resample a low-resolution pass raster onto a painter of the global grid. This is
 * how out-of-focus layers get soft without changing the size of the characters:
 * the blur lives in the raster, the glyph grid stays the project's.
 */
function resampleInto(src: Painter, dst: Painter) {
  for (const [d, s] of [
    [dst.cc, src.colorCanvas],
    [dst.dc, src.densCanvas],
  ] as const) {
    d.save();
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.imageSmoothingEnabled = true;
    d.drawImage(s as any, 0, 0, src.w, src.h, 0, 0, dst.w, dst.h);
    d.restore();
  }
}

export interface RenderOptions {
  width: number;
  height: number;
  /** Performance preview only: scales the global grid (export always uses 1). */
  colsScale?: number;
  /**
   * Optional profiler: when given, renderFrame adds the milliseconds spent in each stage
   * (animation, scene build, every layer, raster passes, ASCII readback/cells, post).
   */
  profile?: Record<string, number>;
  /** Tests/analysis: keep the actor in the scene logic but do not draw it (isolates its silhouette). */
  hideActor?: boolean;
  /** Debug hook: receives the pass rasters before ASCII conversion. */
  debugRaster?: (painters: Painter[]) => void;
}

export interface RenderResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  cols: number;
  rows: number;
  view: View;
  /** Screen position of the actor's head (output px) and px per metre, if visible. */
  head?: { x: number; y: number; s: number };
  /** Character level of detail used for this frame. */
  lod?: CharacterLod;
}

/**
 * Render one frame. Pure with respect to (project, shotIndex, t, options):
 * the same inputs always produce the same pixels.
 */
export function renderFrame(project: Project, shotIndex: number, t: number, opts: RenderOptions): RenderResult {
  const pf = opts.profile;
  const tStart = pf ? performance.now() : 0;
  let tMark = tStart;
  const lap = (k: string) => {
    if (!pf) return;
    const n = performance.now();
    pf[k] = (pf[k] ?? 0) + n - tMark;
    tMark = n;
  };
  /** Wrap draw callbacks so their time is attributed to a named layer. */
  const timed = (k: string, fn: (P: Painter) => void) =>
    pf
      ? (P: Painter) => {
          const a = performance.now();
          fn(P);
          pf['capa: ' + k] = (pf['capa: ' + k] ?? 0) + performance.now() - a;
        }
      : fn;
  const shot = project.shots[shotIndex];
  const W = Math.round(opts.width);
  const H = Math.round(opts.height);
  const VW = VIRTUAL_W;
  const VH = (VIRTUAL_W * H) / W;
  const loc = getLocation(shot.location);
  const seed = shotSeed(project, shot);
  const palette = resolvePalette(project.palette);
  const grade = evalGrade(shot.grade, shot.gradeKeys, t);
  const rt = runtimeFor(project, shot);
  const view = evalCamera(shot.camera, rt?.subject ?? null, t, shot.duration, VW, VH);
  const wind = makeWind(shot.wind, seed);
  const params = { ...loc.params, ...shot.locationParams };
  const ctx: FrameCtx = {
    t,
    frame: Math.round(t * project.fps),
    fps: project.fps,
    seed,
    shot,
    view,
    palette,
    grade,
    wind,
    params,
    fogColor: hexToRgb(loc.fogColor),
    light: {
      side: loc.light.side,
      rim: loc.light.rim,
      rimColor: hexToRgb(loc.light.rimColor),
      ambient: hexToRgb(loc.light.ambient),
      ambientAmt: loc.light.ambientAmt,
    },
    lights: [],
    actor: null,
    effects: shot.effects,
  };

  // the global grid: the same for every shot and camera of the project
  const A = resolveAscii(project, shot);
  const cols0 = Math.max(40, Math.round(A.cols * (opts.colsScale ?? 1)));
  const grid = gridFor(cols0, W, H);
  const cellH = VH / grid.rows;
  // paths land `ry` times lower/taller than shaded bands (see shadeFace); LOD measures what is drawn
  const ry = (((cols0 * SX) / VW) * VH) / (grid.rows * SY);

  const list = new DrawList();
  // actor
  let subjectDepth = shot.camera.distance;
  let headScr: RenderResult['head'];
  let lod: CharacterLod | undefined;
  if (rt && shot.actor) {
    lap('preparación');
    const look = resolveLook(project, shot.actor.character);
    rt.sim.ensure(t);
    lap('animación (pose + tela + pelo)');
    const pose = rt.sim.pose;
    const w = actorWorld(shot.actor, pose.u);
    const p = view.project(w.x, 0, w.z);
    const head = view.project(w.x, 1.7, w.z);
    if (p && head) {
      subjectDepth = p.depth;
      const k = W / VW;
      headScr = { x: head.x * k, y: head.y * k, s: p.s * k };
      ctx.actor = { x: p.x, y: p.y, s: p.s, depth: p.depth, worldX: w.x, worldZ: w.z };
      const vk = clamp((p.y - head.y) / (1.7 * p.s), 0.4, 1.2);
      const elev = view.viewElevation(1.0, w.z);
      const facing = rt.sim.view === 'side' && shot.actor.heading === 'left' ? -1 : 1;
      // adaptive LOD from the projected face height (in grid rows), smoothed over the last 0.45 s
      const sub = rt.subject;
      const rows = smoothedRows((dt) => {
        if (dt > 0 && t - dt < 0) return null;
        const v = dt === 0 ? view : evalCamera(shot.camera, sub, t - dt, shot.duration, VW, VH);
        const pos = dt === 0 ? w : sub.pos(t - dt);
        const a = v.project(pos.x, 0, pos.z);
        const b = v.project(pos.x, 1.7, pos.z);
        if (!a || !b) return null;
        return (((0.25 * (a.y - b.y)) / 1.7) * ry) / cellH;
      });
      const L = computeLod(rows, A.autoLod);
      lod = L;
      if (!opts.hideActor)
        list.add(
        p.depth,
        timed('personaje', (P) => rt.renderer.draw(P, rt.sim, { x: p.x, y: p.y, s: p.s, facing, vk, elev, alpha: 1, lod: L }, ctx.light, seed, look.face)),
        'main',
      );
    }
  }
  lap('personaje: LOD y proyección');
  for (const layer of loc.layers) {
    const g = getGenerator(layer.generator);
    const n0 = list.items.length;
    if (g) g(ctx, layer.params ?? {}, list);
    if (pf) for (let i = n0; i < list.items.length; i++) list.items[i].draw = timed(layer.generator, list.items[i].draw);
  }
  lap('escena: generación de elementos');

  // depth → pass assignment (foreground occluders and out-of-focus background)
  const closeup = shot.camera.type === 'closeup';
  const fgDepth = closeup ? 0 : Math.min(2.8, subjectDepth * 0.42);
  const bgDepth = closeup ? subjectDepth + 1.0 : Infinity;
  const passOf = (d: number, explicit?: PassId): PassId => explicit ?? (d < fgDepth ? 'fg' : d > bgDepth ? 'bg' : 'main');
  const buckets: Record<PassId, typeof list.items> = { bg: [], main: [], fg: [] };
  for (const it of list.items) buckets[passOf(it.depth, it.pass)].push(it);
  for (const k of Object.keys(buckets) as PassId[]) buckets[k].sort((a, b) => b.depth - a.depth);

  const glyphs = getGlyphSet(A.charset);
  const passes: PassInput[] = [];
  /**
   * Every pass is composed on the global grid. `soft` < 1 draws the pass at a lower
   * raster resolution and resamples it (defocus) - the characters keep their size.
   */
  const mk = (id: PassId, soft: number, occlude: number, densityGain: number, colorGain: number) => {
    if (!buckets[id].length) return;
    const P = painterFor(grid.cols, grid.rows, VW, VH, id);
    if (soft < 1) {
      const g = gridFor(Math.max(24, Math.round(cols0 * soft)), W, H);
      const lo = painterFor(g.cols, g.rows, VW, VH, id + ':lo');
      lo.soft = true;
      for (const it of buckets[id]) it.draw(lo);
      resampleInto(lo, P);
    } else for (const it of buckets[id]) it.draw(P);
    lap('raster: pase ' + id);
    passes.push({ painter: P, glyphs, occlude, densityGain: densityGain * A.density, colorGain });
  };
  mk('bg', 0.42, 0, 0.85, 0.72);
  // when a defocused background exists, the in-focus pass must hide it where it has content
  mk('main', 1, passes.length ? 0.97 : 0, 1, 1);
  mk('fg', 0.68, 0.92, 0.95, 0.75);
  if (opts.debugRaster) opts.debugRaster(passes.map((p) => p.painter));
  lap('raster: otros');

  const data = new Uint8ClampedArray(W * H * 4);
  const grader = makeGrader(grade, palette);
  composeAscii(data, passes, {
    width: W,
    height: H,
    vw: VW,
    vh: VH,
    bg: palette.black,
    bgGlow: A.bgGlow,
    dither: A.dither,
    grade: grader,
    lights: ctx.lights,
    glyphGain: A.glyphGain,
    contrast: A.contrast,
    sharpness: A.sharpness,
    profile: pf,
  });
  lap('ascii: total composición');
  applyPost(data, W, H, shot.effects, ctx.frame + shotIndex * 100000, seed);
  lap('post: grano, viñeta, fundido');
  // transition in
  if (shot.transitionIn.type === 'fade' && shot.transitionIn.duration > 0 && t < shot.transitionIn.duration) {
    const f = smoothstep(0, shot.transitionIn.duration, t);
    for (let i = 0; i < data.length; i += 4) {
      data[i] *= f;
      data[i + 1] *= f;
      data[i + 2] *= f;
    }
  }
  if (pf) pf['TOTAL'] = (pf['TOTAL'] ?? 0) + performance.now() - tStart;
  return { data, width: W, height: H, cols: grid.cols, rows: grid.rows, view, head: headScr, lod };
}

/** Clear cached simulations (e.g. after loading a project). */
export function resetRuntimes() {
  runtimes.clear();
}
