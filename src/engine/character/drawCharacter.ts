import { hexToRgb, mix, type RGB } from '../core/color';
import { clamp, lerp, type Vec2 } from '../core/math';
import { hashf } from '../core/rng';
import { noise1 } from '../core/noise';
import type { Painter, Paint } from '../raster/Painter';
import { CharacterSim, headCenter, headOrientFor } from '../animation/characterSim';
import { FACE, orient, SKULL, type HeadOrient, type V3 } from './head';
import { faceFrontZ, resolveFace, shadeFace, type FaceParams } from './face';
import { computeLod, type CharacterLod, type LodWeights } from './lod';
import type { CharacterDef } from './types';

export interface CharacterLight {
  /** Screen side the key/rim light comes from: -1 left, +1 right. */
  side: number;
  rimColor: RGB;
  rim: number;
  /** Ambient tint mixed into the character colours. */
  ambient: RGB;
  ambientAmt: number;
}

export interface CharacterScreen {
  /** Screen position of the root (ground under the pelvis). */
  x: number;
  y: number;
  /** px per metre. */
  s: number;
  /** +1 heading screen-right, -1 mirrored. Front/back views use +1. */
  facing: number;
  /** Vertical foreshortening from an elevated camera (1 = none). */
  vk: number;
  /** Camera elevation angle seen from the character (rad). */
  elev: number;
  /** Fade (memories / transitions). */
  alpha: number;
  /** Adaptive level of detail (absent = derived from the on-screen scale). */
  lod?: CharacterLod;
}

interface Mat {
  c: RGB;
  d: number;
}

function pal(def: CharacterDef, L: CharacterLight) {
  const k = (h: string) => mix(hexToRgb(h), L.ambient, L.ambientAmt);
  const C = def.colors;
  return {
    skin: k(C.skin),
    skinShadow: k(C.skinShadow),
    hair: k(C.hair),
    hairLight: k(C.hairLight),
    cloak: k(C.cloak),
    cloakLight: k(C.cloakLight),
    rim: L.rimColor,
    cross: k(C.cross),
    eyes: hexToRgb(C.eyes),
    lips: k(C.lips),
    boots: k(C.boots),
    trousers: k(C.trousers),
  };
}

const paint = (m: Mat, alpha = 1): Paint => ({ color: m.c, density: m.d, alpha });

/** Monotone-chain convex hull. */
function hull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Vec2[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  up.pop();
  lo.pop();
  return lo.concat(up);
}

/** Evenly resample a closed polygon to n points. */
function resample(pts: Vec2[], n: number): Vec2[] {
  if (pts.length < 3) return pts;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(l);
    total += l;
  }
  const out: Vec2[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const d = (k / n) * total;
    while (i < pts.length - 1 && acc + seg[i] < d) acc += seg[i++];
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const f = seg[i] > 0 ? (d - acc) / seg[i] : 0;
    out.push({ x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) });
  }
  return out;
}

/** Tapered ribbon along a polyline (screen space). */
function ribbon(P: Painter, pts: Vec2[], w0: number, w1: number) {
  if (pts.length < 2) return;
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    const w = lerp(w0, w1, i / (pts.length - 1)) / 2;
    left.push({ x: pts[i].x + nx * w, y: pts[i].y + ny * w });
    right.push({ x: pts[i].x - nx * w, y: pts[i].y - ny * w });
  }
  P.beginPath();
  P.smoothPath([...left, ...right.reverse()], true, 0.35);
}

export class CharacterRenderer {
  private def: CharacterDef;
  constructor(def: CharacterDef) {
    this.def = def;
  }

  /** Draws the whole character for its sim view. */
  draw(P: Painter, sim: CharacterSim, scr: CharacterScreen, L: CharacterLight, seed: number, face?: Partial<FaceParams>) {
    const F = resolveFace(face);
    const pose = sim.pose;
    const C = pal(this.def, L);
    const s = scr.s;
    const detail = clamp((s - 60) / 500);
    // fallback LOD (no grid info): ~9.7 virtual px per row at the default 360-column grid
    const lod = scr.lod ?? computeLod((0.25 * s * scr.vk) / 9.7, true);
    const W = lod.w;
    // the figure hides glyph hints of anything drawn behind it
    P.clearHints(scr.x - 0.2 * s, scr.y - 1.85 * s * scr.vk, scr.x + 0.2 * s, scr.y);
    // heading/lateral space → screen
    const rootU = sim.view === 'side' ? pose.u : 0;
    const X = (u: number) => scr.x + (u - rootU) * s * scr.facing;
    const Y = (y: number) => scr.y - y * s * scr.vk;
    const T = (p: Vec2): Vec2 => ({ x: X(p.x), y: Y(p.y) });
    const A = scr.alpha;

    // contact shadow (grounds the figure; larger from above)
    P.beginPath();
    const shW = (sim.view === 'side' ? 0.5 : 0.42) * s;
    P.ellipse(scr.x, scr.y + 0.01 * s, shW * (0.9 + scr.elev), Math.max(1.5, shW * (0.08 + Math.sin(scr.elev) * 0.5)));
    P.fill({ color: [0.02, 0.01, 0.015], density: 0.08, alpha: 0.55 * A });

    if (sim.view === 'side') this.drawLegsSide(P, sim, T, C, s, A);
    else this.drawFeetFront(P, sim, T, C, s, A, scr);

    this.drawCloak(P, sim, T, C, L, s, A, seed, scr, F.style === 'v1' ? null : W);

    // head + hair
    const hc = T(headCenter(sim.view, pose));
    const o = headOrientFor(sim.view, pose);
    if (scr.facing < 0) {
      o.yaw = -o.yaw;
      o.tilt = -o.tilt;
    }
    if (F.style === 'v1') this.drawHeadV1(P, sim, hc, s, scr, o, pose.eyeOpen, C, L, detail, T, A, seed);
    else this.drawHeadV2(P, sim, hc, s, scr, o, pose.eyeOpen, C, L, W, T, A, seed, F);
  }

  private drawLegsSide(P: Painter, sim: CharacterSim, T: (p: Vec2) => Vec2, C: ReturnType<typeof pal>, s: number, A: number) {
    const pose = sim.pose;
    for (const k of [1, 0]) {
      const dark = k === 1 ? 0.55 : 1;
      const tr: Mat = { c: mix(C.trousers, [0, 0, 0], 1 - dark), d: 0.5 };
      const bt: Mat = { c: mix(C.boots, [0, 0, 0], 1 - dark), d: 0.62 };
      const hip = T(pose.hip);
      const knee = T(pose.knees[k]);
      const f = pose.feet[k];
      const ank = T(f.ankle);
      P.beginPath();
      P.moveTo(hip.x, hip.y);
      P.lineTo(knee.x, knee.y);
      P.lineTo(ank.x, ank.y);
      P.stroke(paint(tr, A), 0.1 * s);
      // boot
      const heel = T(f.heel);
      const toe = T(f.toe);
      const up = { x: (ank.x - heel.x) * 1.1, y: (ank.y - heel.y) * 1.1 };
      P.beginPath();
      P.moveTo(heel.x, heel.y);
      P.lineTo(toe.x, toe.y);
      P.quadTo(toe.x + up.x * 0.1, toe.y + up.y * 0.7, lerp(toe.x, ank.x, 0.45) + up.x * 0.3, lerp(toe.y, ank.y, 0.45) + up.y * 0.3);
      P.lineTo(ank.x + up.x * 0.2, ank.y + up.y * 0.2 - 0.03 * s);
      P.lineTo(heel.x + up.x * 0.9, heel.y + up.y * 0.9);
      P.closePath();
      P.fill(paint(bt, A));
    }
  }

  private drawFeetFront(P: Painter, sim: CharacterSim, T: (p: Vec2) => Vec2, C: ReturnType<typeof pal>, s: number, A: number, scr: CharacterScreen) {
    const pose = sim.pose;
    for (const k of [0, 1]) {
      const f = pose.feet[k];
      const lat = pose.sway * 0.3 + (k === 0 ? 0.1 : -0.1);
      // depth offset of the foot toward the camera shows as a lower, slightly larger boot
      const fwd = (f.toe.x - pose.hip.x) * (sim.view === 'back' ? -1 : 1);
      const yOff = fwd * Math.sin(scr.elev) * 0.9;
      const sc = 1 + fwd * 0.04;
      const base = T({ x: lat, y: Math.max(0, f.heel.y + f.toe.y) * 0.5 - yOff });
      P.beginPath();
      P.ellipse(base.x, base.y - 0.03 * s * sc, 0.055 * s * sc, 0.04 * s * sc);
      P.fill(paint({ c: C.boots, d: 0.6 }, A));
    }
  }

  /** W = LOD weights (null = legacy look for the v1 comparison style). */
  private drawCloak(
    P: Painter,
    sim: CharacterSim,
    T: (p: Vec2) => Vec2,
    C: ReturnType<typeof pal>,
    L: CharacterLight,
    s: number,
    A: number,
    seed: number,
    scr: CharacterScreen,
    W: LodWeights | null,
  ) {
    const wFold = W ? W.folds : 1;
    const wHem = W ? W.hem : 1;
    const wSil = W ? W.silhouette : 0;
    const V = sim.cloak;
    const nc = sim.nc;
    const nr = sim.nr;
    const pt = (r: number, c: number) => T({ x: V.x[sim.idx(r, c)], y: V.y[sim.idx(r, c)] });
    const edgeA: Vec2[] = [];
    const edgeB: Vec2[] = [];
    for (let r = 0; r < nr; r++) {
      edgeA.push(pt(r, 0));
      edgeB.push(pt(r, nc - 1));
    }
    const hem: Vec2[] = [];
    for (let c = 0; c < nc; c++) hem.push(pt(nr - 1, c));
    const collar: Vec2[] = [];
    for (let c = nc - 1; c >= 0; c--) collar.push(pt(0, c));
    const outline = [...edgeA, ...hem.slice(1, -1), ...edgeB.reverse(), ...collar.slice(1, -1)];

    // base silhouette
    P.beginPath();
    P.smoothPath(outline, true, 0.4);
    // tiny figures: denser body so the silhouette survives the glyph grid
    P.fill(paint({ c: C.cloak, d: 0.14 + 0.24 * wSil }, A));

    // shaded quads: folds from horizontal compression, light from the key side
    const lightS = L.side * (scr.facing >= 0 ? 1 : -1);
    for (let r = 0; r < nr - 1; r++) {
      for (let c = 0; c < nc - 1; c++) {
        const a = pt(r, c);
        const b = pt(r, c + 1);
        const d = pt(r + 1, c + 1);
        const e = pt(r + 1, c);
        const wTop = Math.hypot(b.x - a.x, b.y - a.y);
        const wBot = Math.hypot(d.x - e.x, d.y - e.y);
        const restW = (wTop + wBot) / 2;
        // compressed panels are folded into shadow, stretched ones catch light
        const ideal = (sim.view === 'side' ? 0.11 : 0.1) * s * (0.6 + (r / nr) * 0.9);
        const comp = clamp(restW / ideal, 0.2, 1.6);
        // side facing the light
        const cn = sim.view === 'side' ? (c / (nc - 2) - 0.5) * -lightS : (c / (nc - 2) - 0.5) * lightS;
        const shade = clamp(0.4 + (comp - 1) * 0.35 + cn * 0.55 + (hashf(seed, r, c) - 0.5) * 0.08);
        const col = mix(mix(C.cloak, [0.01, 0.005, 0.008], 0.55), C.cloakLight, shade);
        P.beginPath();
        P.polygon([a, b, d, e]);
        P.fill({ color: col, density: 0.06 + shade * 0.28, alpha: 0.85 * A });
      }
    }
    // fold lines along interior columns (drapery): sparse dark creases, a few lit ridges
    for (let c = 1; c < nc - 1 && wFold > 0.01; c++) {
      if (hashf(seed, c, 6) < 0.35) continue;
      const line: Vec2[] = [];
      for (let r = 3; r < nr; r++) line.push(pt(r, c));
      P.beginPath();
      P.smoothPath(line, false, 0.5);
      P.stroke({ color: mix(C.cloak, [0, 0, 0], 0.7), density: 0.06, alpha: 0.7 * A * wFold }, Math.max(0.8, 0.011 * s));
      if (hashf(seed, c, 7) > 0.55) {
        P.beginPath();
        P.smoothPath(line.map((p) => ({ x: p.x + 0.016 * s, y: p.y })), false, 0.5);
        P.stroke({ color: C.cloakLight, density: 0.45, alpha: 0.35 * A * wFold }, Math.max(0.7, 0.007 * s));
      }
    }
    // frayed hem: hanging threads that trail the motion
    for (let c = 0; c < nc - 1 && wHem > 0.01; c++) {
      const a = hem[c];
      const b = hem[c + 1];
      const i0 = sim.idx(nr - 1, c);
      const vx = (V.x[i0] - V.px[i0]) * 120;
      const n = 3;
      for (let k = 0; k < n; k++) {
        const f = (k + hashf(seed, c, k, 3)) / n;
        const x = lerp(a.x, b.x, f);
        const y = lerp(a.y, b.y, f);
        const len = (0.025 + hashf(seed, c, k, 4) * 0.05) * s;
        const sway = -vx * 0.04 * s * scr.facing;
        P.beginPath();
        P.moveTo(x - 0.012 * s, y - 0.01 * s);
        P.lineTo(x + sway, y + len);
        P.lineTo(x + 0.012 * s, y - 0.01 * s);
        P.closePath();
        P.fill(paint({ c: C.cloak, d: 0.45 }, A * wHem));
      }
    }
    // chest cross (front view, or a sliver of it in profile)
    if (sim.view === 'front') {
      const mid = (nc - 1) / 2;
      const cl = Math.floor(mid);
      const vert: Vec2[] = [];
      for (let r = 1; r <= 9; r++) vert.push(pt(r, cl));
      P.beginPath();
      P.smoothPath(vert, false, 0.5);
      P.stroke({ color: C.cross, density: 0.72, alpha: 0.9 * A }, Math.max(1.2, 0.018 * s));
      const r3 = 3;
      P.beginPath();
      P.moveTo(pt(r3, cl - 2).x, pt(r3, cl - 2).y);
      P.quadTo(pt(r3, cl).x, pt(r3, cl).y - 0.01 * s, pt(r3, cl + 2).x, pt(r3, cl + 2).y);
      P.stroke({ color: C.cross, density: 0.72, alpha: 0.9 * A }, Math.max(1.2, 0.018 * s));
    } else if (sim.view === 'side') {
      const vert: Vec2[] = [];
      for (let r = 1; r <= 8; r++) {
        const p = pt(r, 0);
        vert.push({ x: p.x - 0.025 * s * scr.facing, y: p.y });
      }
      P.beginPath();
      P.smoothPath(vert, false, 0.5);
      P.stroke({ color: C.cross, density: 0.65, alpha: 0.55 * A }, Math.max(1, 0.012 * s));
    }
    // tiny figures: a full contour in the rim colour so the silhouette survives at a few cells
    if (wSil > 0.02) {
      P.beginPath();
      P.smoothPath(outline, true, 0.4);
      P.stroke({ color: L.rimColor, density: 0.85, alpha: 0.75 * wSil * A }, 2 + 3 * wSil);
    }
    // rim light along the edge facing the light (red sky behind)
    if (L.rim > 0) {
      const side = sim.view === 'side' ? (lightS > 0 ? edgeA : [...edgeB].reverse()) : lightS > 0 ? [...edgeB].reverse() : edgeA;
      const pts = side.slice(1);
      P.beginPath();
      P.smoothPath(pts, false, 0.5);
      P.stroke({ color: L.rimColor, density: 0.8, alpha: Math.min(1, 0.75 * L.rim * A * (1 + 0.5 * wSil)) }, Math.max(1.2 + 1.6 * wSil, 0.02 * s));
    }
  }

  /** The original prototype head (kept for before/after comparison). */
  private drawHeadV1(
    P: Painter,
    sim: CharacterSim,
    hc: Vec2,
    s: number,
    scr: CharacterScreen,
    o: HeadOrient,
    eyeOpen: number,
    C: ReturnType<typeof pal>,
    L: CharacterLight,
    detail: number,
    T: (p: Vec2) => Vec2,
    A: number,
    seed: number,
  ) {
    const vk = scr.vk;
    const pj = (p: V3) => {
      const q = orient(p, o);
      return { x: hc.x + q[0] * s, y: hc.y - q[1] * s * vk, z: q[2] };
    };
    const faceVisible = Math.cos(o.yaw) > -0.25;

    // neck
    const nb = pj([0, -0.1, -0.015]);
    const nk = T(sim.pose.neck);
    P.beginPath();
    P.moveTo(nb.x - 0.04 * s, nb.y);
    P.lineTo(nb.x + 0.04 * s, nb.y);
    P.lineTo(nk.x + 0.05 * s, nk.y + 0.02 * s);
    P.lineTo(nk.x - 0.05 * s, nk.y + 0.02 * s);
    P.closePath();
    P.fill(paint({ c: C.skinShadow, d: 0.45 }, A));

    // hair behind the head + back hair mass
    const strands = sim.strands;
    const strandPts = strands.map((_, si) => sim.hairStrandPoints(si).map((p) => T(p)));
    const rootZ = strands.map((st) => orient(st.pts[1], o)[2]);
    const skullPts: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 28; i++) {
      for (const lat of [-0.5, 0, 0.5, 1.0, 1.4]) {
        const lon = (i / 28) * Math.PI * 2;
        skullPts.push(pj([Math.sin(lon) * Math.cos(lat) * SKULL.rx * 1.08, Math.sin(lat) * SKULL.ry * 1.08, Math.cos(lon) * Math.cos(lat) * SKULL.rz * 1.08]));
      }
    }
    const hairMat: Mat = { c: C.hair, d: 0.4 };
    P.beginPath();
    P.smoothPath(hull([...skullPts, ...strandPts.flatMap((p) => p.slice(0, 4))]), true, 0.3);
    P.fill(paint(hairMat, A));
    const sw = Math.max(1, s * 0.022);
    for (let si = 0; si < strands.length; si++) {
      if (rootZ[si] > 0.0) continue;
      ribbon(P, strandPts[si], sw * (strands[si].width / 0.02), sw * 0.25);
      P.fill(paint(hairMat, A));
    }

    if (faceVisible) {
      // face skin: hull of the facial contour
      const facePts: V3[] = [...FACE.midline, ...FACE.side, ...FACE.side.map((p) => [-p[0], p[1], p[2]] as V3)];
      // the skull front for the forehead
      for (let i = -3; i <= 3; i++) facePts.push([i * 0.022, 0.07, 0.07]);
      const proj = facePts.map(pj).filter((p) => p.z > -0.03);
      const faceHull = hull(proj);
      P.beginPath();
      P.smoothPath(faceHull, true, 0.25);
      P.fill(paint({ c: C.skin, d: 0.55 }, A));

      // half the face in shadow (key light from one side)
      const sideSign = -L.side;
      const shadowPts = [...FACE.midline, ...FACE.side.map((p) => [p[0] * sideSign, p[1], p[2]] as V3)];
      for (let i = 0; i <= 3; i++) shadowPts.push([sideSign * i * 0.022, 0.07, 0.07]);
      const sp = shadowPts.map(pj).filter((p) => p.z > -0.03);
      if (sp.length > 2) {
        P.beginPath();
        P.smoothPath(hull(sp), true, 0.25);
        P.fill({ color: C.skinShadow, density: 0.4, alpha: 0.72 * A });
      }

      // eye sockets + eyes: dark, empty, heavy-lidded
      for (const [eye, brow, sx] of [
        [FACE.eyeL, FACE.browL, -1],
        [FACE.eyeR, FACE.browR, 1],
      ] as [V3, V3, number][]) {
        const n = orient([sx * 0.38, 0.05, 0.92], o)[2];
        if (n < 0.08) continue;
        const e = pj(eye);
        const fs = clamp(n * 1.15);
        const ew = 0.017 * s * fs;
        const eh = 0.0075 * s * vk;
        // socket shadow
        P.beginPath();
        P.ellipse(e.x, e.y - eh * 0.2, ew * 1.55, eh * 2.3);
        P.fill({ color: mix(C.skinShadow, [0, 0, 0], 0.4), density: 0.16, alpha: 0.8 * A });
        // the eye itself: almost no ink → reads as a void in the pale face
        P.beginPath();
        P.ellipse(e.x, e.y, ew, Math.max(0.4, eh * eyeOpen), o.tilt);
        P.fill({ color: C.eyes, density: 0.06, alpha: A });
        // heavy upper lid
        P.beginPath();
        P.moveTo(e.x - ew * 1.1, e.y);
        P.quadTo(e.x, e.y - eh * (0.6 + 1.4 * eyeOpen), e.x + ew * 1.1, e.y + eh * 0.2);
        P.stroke({ color: [0.06, 0.03, 0.035], density: 0.75, alpha: 0.9 * A }, Math.max(0.8, 0.004 * s));
        if (detail > 0.3) {
          // lower lid / tired shadow
          P.beginPath();
          P.moveTo(e.x - ew * 0.9, e.y + eh * 0.9);
          P.quadTo(e.x, e.y + eh * 2.2, e.x + ew, e.y + eh * 0.8);
          P.stroke({ color: C.skinShadow, density: 0.35, alpha: 0.55 * A }, Math.max(0.6, 0.003 * s));
          const b = pj(brow);
          P.beginPath();
          P.moveTo(b.x - ew * 1.2, b.y + eh * 0.4);
          P.lineTo(b.x + ew * 1.2, b.y);
          P.stroke({ color: C.hair, density: 0.6, alpha: 0.7 * A }, Math.max(0.6, 0.004 * s));
        }
      }
      // nose: shadow on the dark side + nostril
      const nt = pj(FACE.noseTip);
      const nbse = pj(FACE.noseBase);
      const br = pj([0, 0.01, 0.1]);
      P.beginPath();
      P.moveTo(br.x + sideSign * 0.008 * s, br.y);
      P.quadTo(nt.x + sideSign * 0.01 * s, nt.y, nbse.x, nbse.y);
      P.stroke({ color: C.skinShadow, density: 0.25, alpha: 0.7 * A }, Math.max(0.7, 0.006 * s));
      // mouth: thin, slightly down-turned, no expression
      const ml = pj(FACE.mouthL);
      const mm = pj(FACE.mouth);
      const mr = pj(FACE.mouthR);
      if (mm.z > 0.02) {
        P.beginPath();
        P.moveTo(ml.x, ml.y + 0.002 * s);
        P.quadTo(mm.x, mm.y - 0.002 * s, mr.x, mr.y + 0.002 * s);
        P.stroke({ color: mix(C.lips, [0, 0, 0], 0.4), density: 0.12, alpha: 0.9 * A }, Math.max(0.7, 0.006 * s));
        if (detail > 0.4) {
          P.beginPath();
          P.ellipse(mm.x, mm.y + 0.008 * s, 0.012 * s, 0.003 * s);
          P.fill({ color: C.lips, density: 0.35, alpha: 0.35 * A });
        }
      }
    }

    // hair in front: cap over the forehead/temples + front strands + bangs
    const capPts: { x: number; y: number }[] = [];
    strands.forEach((st, si) => {
      for (let k = 0; k < 3; k++) {
        const q = orient(st.pts[k], o);
        if (q[2] > -0.02) capPts.push(strandPts[si][k]);
      }
    });
    for (const p of skullPts) if (p.z > 0 && p.y < hc.y - 0.05 * s * vk) capPts.push(p);
    if (capPts.length > 2) {
      P.beginPath();
      P.smoothPath(hull(capPts), true, 0.3);
      P.fill(paint(hairMat, A));
    }
    const sub = detail > 0.5 ? 3 : 1;
    for (let si = 0; si < strands.length; si++) {
      if (rootZ[si] <= 0.0) continue;
      const pts = strandPts[si];
      for (let k = 0; k < sub; k++) {
        const off = sub > 1 ? (hashf(seed, si, k) - 0.5) * 0.03 * s : 0;
        const len = sub > 1 ? 0.75 + hashf(seed, si, k, 1) * 0.35 : 1;
        const pp = pts.map((p, j) => {
          const f = j / (pts.length - 1);
          const base = pts[0];
          return { x: base.x + (p.x - base.x) * (f < 0.5 ? 1 : len) + off * f, y: base.y + (p.y - base.y) * (f < 0.5 ? 1 : len) };
        });
        ribbon(P, pp, (sw * (strands[si].width / 0.02)) / Math.sqrt(sub), sw * 0.15);
        P.fill(paint(k === 1 ? { c: C.hairLight, d: 0.55 } : hairMat, A));
      }
    }
    // rim on the hair silhouette
    if (L.rim > 0 && detail < 0.5) {
      const edge = hull(skullPts.filter((p) => p.y < hc.y));
      const lightS = L.side;
      const rimPts = edge.filter((p) => (p.x - hc.x) * lightS > 0);
      if (rimPts.length > 1) {
        rimPts.sort((a, b) => a.y - b.y);
        P.beginPath();
        P.smoothPath(rimPts, false, 0.5);
        P.stroke({ color: L.rimColor, density: 0.75, alpha: 0.5 * L.rim * A }, Math.max(1, 0.015 * s));
      }
    }
  }

  /**
   * Face v2 (see face.ts): a lit 3D face surface, layered irregular hair with
   * individual locks, bangs resting on the forehead (swayed by the simulated
   * hair) and a high cloak collar that wraps the neck up to the jaw.
   */
  private drawHeadV2(
    P: Painter,
    sim: CharacterSim,
    hc: Vec2,
    s: number,
    scr: CharacterScreen,
    o: HeadOrient,
    eyeOpen: number,
    C: ReturnType<typeof pal>,
    L: CharacterLight,
    W: LodWeights,
    T: (p: Vec2) => Vec2,
    A: number,
    seed: number,
    F: FaceParams,
  ) {
    const vk = scr.vk;
    const pose = sim.pose;
    const pj = (p: V3) => {
      const q = orient(p, o);
      return { x: hc.x + q[0] * s, y: hc.y - q[1] * s * vk, z: q[2] };
    };
    const faceVisible = Math.cos(o.yaw) > -0.3;
    const hv = F.hairVolume;
    const strands = sim.strands;
    const strandPts = strands.map((_, si) => sim.hairStrandPoints(si).map((p) => T(p)));
    const rootZ = strands.map((st) => orient(st.pts[1], o)[2]);
    const sw = Math.max(1, s * 0.022);
    const hairDark: Mat = { c: C.hair, d: 0.42 };
    const hairMid: Mat = { c: mix(C.hair, C.hairLight, 0.45), d: 0.52 };
    const hairSheen: Mat = { c: C.hairLight, d: 0.64 };
    const hairDeep: Mat = { c: mix(C.hair, [0, 0, 0], 0.45), d: 0.26 };
    // LOD: locks per strand (the last one fades in), fine hair, bangs, rim
    const sub = Math.max(1, Math.ceil(W.locks - 1e-6));
    const subFrac = W.locks - (sub - 1);

    /** One simulated strand drawn as several separated locks of varying density. */
    const drawLocks = (pts: Vec2[], width: number, si: number, n: number, spread: number, lenK = 0.78, lastA = 1) => {
      const base = pts[0];
      for (let k = 0; k < n; k++) {
        const h1 = hashf(seed, si, k, 21);
        const h2 = hashf(seed, si, k, 22);
        const off = (n > 1 ? k / (n - 1) - 0.5 : 0) * spread * s + (h1 - 0.5) * 0.012 * s;
        const len = (n > 1 ? 0.62 + h2 * 0.4 : 0.85) * lenK;
        const pp = pts.map((p, j) => {
          const f = j / (pts.length - 1);
          const ff = lerp(1, len, f * f);
          return { x: base.x + (p.x - base.x) * ff + off * (0.25 + f), y: base.y + (p.y - base.y) * ff };
        });
        ribbon(P, pp, (width * (0.55 + h1 * 0.6)) / Math.sqrt(n * 0.6 + 0.4), width * 0.06);
        P.fill(paint(h2 > 0.84 ? hairSheen : h2 > 0.45 ? hairMid : hairDark, A * (k === n - 1 && n > 1 ? lastA : 1)));
      }
    };

    /** Locks hanging at the temples/cheeks. Seen from the front they frame the face; in profile they sit behind it. */
    const profileish = Math.abs(Math.sin(o.yaw)) > 0.55;
    const drawFrontLocks = () => {
      for (let si = 0; si < strands.length; si++) {
        if (rootZ[si] <= 0 || strands[si].kind === 'bang' || strands[si].kind === 'crown') continue;
        const n = Math.max(1, sub - 1);
        drawLocks(strandPts[si], sw * (strands[si].width / 0.02), si, n, 0.026 * hv, 0.78, sub > 2 ? subFrac : 1);
      }
    };

    // ---- back hair mass: irregular silhouette (not a round hull) ----
    const skullPts: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 32; i++) {
      const lon = (i / 32) * Math.PI * 2;
      for (const lat of [-0.6, -0.3, 0, 0.5, 1.0, 1.4]) {
        skullPts.push(
          pj([Math.sin(lon) * Math.cos(lat) * SKULL.rx * 1.3 * hv, Math.sin(lat) * SKULL.ry * 1.08 + (lat < 0 ? -0.02 : 0), Math.cos(lon) * Math.cos(lat) * SKULL.rz * 1.12]),
        );
      }
    }
    const massSrc: Vec2[] = [...skullPts];
    strands.forEach((st, si) => {
      if (st.kind === 'side' || st.kind === 'back') massSrc.push(...strandPts[si].slice(0, 4));
    });
    const rough = resample(hull(massSrc), 56).map((p) => {
      const a = Math.atan2(p.y - hc.y, p.x - hc.x);
      const k = 1 + (noise1(a * 2.2 + 11, seed + 77) * 0.6 + noise1(a * 7.3 + 3, seed + 78) * 0.4) * 0.13 * hv;
      return { x: hc.x + (p.x - hc.x) * k, y: hc.y + (p.y - hc.y) * k };
    });
    P.beginPath();
    P.smoothPath(rough, true, 0.35);
    P.fill(paint(hairDeep, A));
    for (let si = 0; si < strands.length; si++) {
      if (rootZ[si] > 0 || strands[si].kind === 'bang' || strands[si].kind === 'crown') continue;
      const n = sub;
      drawLocks(strandPts[si], sw * (strands[si].width / 0.02) * 1.15, si, n, 0.04 * hv, 0.78, subFrac);
    }

    // ---- neck (short, in shadow) and the high collar ----
    const nb = pj([0, -0.1, -0.015]);
    const nk = T(pose.neck);
    P.beginPath();
    P.moveTo(nb.x - 0.034 * s, nb.y);
    P.lineTo(nb.x + 0.034 * s, nb.y);
    P.lineTo(nk.x + 0.044 * s, nk.y + 0.02 * s);
    P.lineTo(nk.x - 0.044 * s, nk.y + 0.02 * s);
    P.closePath();
    P.fill(paint({ c: mix(C.skinShadow, [0, 0, 0], 0.3), d: 0.26 }, A));
    if (F.collar > 0) {
      const chin = pj(FACE.chin);
      const cxC = (nk.x + nb.x) / 2;
      const side = sim.view === 'side' ? 0.85 : 1;
      const topY = lerp(nk.y + 0.02 * s * vk, chin.y + 0.01 * s * vk, clamp(0.75 * F.collar, 0, 1));
      const botY = nk.y + 0.1 * s * vk;
      const hwT = 0.066 * s * side;
      const hwB = 0.17 * s * side;
      const dip = (faceVisible && sim.view !== 'side' ? 0.016 : 0.004) * s * vk;
      const top = [
        { x: cxC - hwT * 1.08, y: topY + 0.012 * s * vk },
        { x: cxC - hwT * 0.55, y: topY - 0.004 * s * vk },
        { x: cxC, y: topY + dip },
        { x: cxC + hwT * 0.55, y: topY - 0.004 * s * vk },
        { x: cxC + hwT * 1.08, y: topY + 0.012 * s * vk },
      ];
      P.beginPath();
      P.smoothPath([{ x: cxC - hwB, y: botY }, ...top, { x: cxC + hwB, y: botY }, { x: cxC, y: botY + 0.03 * s * vk }], true, 0.35);
      P.fill(paint({ c: mix(C.cloak, [0, 0, 0], 0.25), d: 0.24 }, A));
      // rolled lip catching the light, then a few soft folds
      P.beginPath();
      P.smoothPath(top, false, 0.4);
      P.stroke({ color: C.cloakLight, density: 0.45, alpha: 0.25 * A }, Math.max(0.8, 0.008 * s));
      for (let k = -2; k <= 2; k++) {
        const fx = cxC + k * 0.032 * s * side + (hashf(seed, k + 2, 41) - 0.5) * 0.012 * s;
        const lit = k * L.side > 0;
        P.beginPath();
        P.moveTo(fx, topY + 0.02 * s * vk);
        P.quadTo(fx + k * 0.02 * s, (topY + botY) / 2, fx + k * 0.05 * s, botY);
        P.stroke(
          lit ? { color: C.cloakLight, density: 0.36, alpha: 0.18 * A } : { color: [0.01, 0.005, 0.008], density: 0.08, alpha: 0.45 * A },
          Math.max(0.7, 0.008 * s),
        );
      }
    }

    // ---- the face itself ----
    if (profileish) drawFrontLocks();
    if (faceVisible) {
      shadeFace(P, F, {
        cx: hc.x,
        cy: hc.y,
        s,
        vk,
        o,
        lightSide: L.side,
        rim: L.rim,
        rimColor: L.rimColor,
        eyeOpen,
        colors: { skin: C.skin, skinShadow: C.skinShadow, eyes: C.eyes, lips: C.lips, hair: C.hair },
        alpha: A,
        lod: { relief: W.relief, features: W.features, ecu: W.ecu },
      });
    }

    // ---- hair in front: crown cap, side curtains, bangs, flyaways ----
    const capPts: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 28; i++) {
      const lon = (i / 28) * Math.PI * 2;
      for (const lat of [0.5, 0.8, 1.1, 1.45]) {
        const q = pj([Math.sin(lon) * Math.cos(lat) * SKULL.rx * 1.1 * hv, Math.sin(lat) * SKULL.ry * 1.06, Math.cos(lon) * Math.cos(lat) * SKULL.rz * 1.1]);
        if (q.z > -0.04) capPts.push(q);
      }
    }
    if (capPts.length > 2) {
      P.beginPath();
      P.smoothPath(hull(capPts), true, 0.3);
      P.fill(paint(hairDark, A));
    }
    if (!profileish) drawFrontLocks();
    if (faceVisible && W.bangs > 0.01) {
      // sway of the simulated bang strands (lag + wind), applied to the drawn bangs
      const oSim = headOrientFor(sim.view, pose);
      const hcSim = headCenter(sim.view, pose);
      let swx = 0;
      let swy = 0;
      let nSw = 0;
      strands.forEach((st, si) => {
        if (st.kind !== 'bang') return;
        const last = st.pts.length - 1;
        const r = orient(st.pts[last], oSim);
        const rest = T({ x: hcSim.x + r[0], y: hcSim.y + r[1] });
        swx += strandPts[si][last].x - rest.x;
        swy += strandPts[si][last].y - rest.y;
        nSw++;
      });
      if (nSw) {
        swx = clamp(swx / nSw, -0.03 * s, 0.03 * s);
        swy = clamp(swy / nSw, -0.02 * s, 0.02 * s);
      }
      const nB = 12;
      const kx = 1.1 / 0.06;
      for (let i = 0; i < nB; i++) {
        const h1 = hashf(seed, i, 31);
        const h2 = hashf(seed, i, 32);
        const h3 = hashf(seed, i, 33);
        const h4 = hashf(seed, i, 34);
        const x0 = lerp(-0.058, 0.058, (i + 0.5) / nB) + (h1 - 0.5) * 0.008;
        // the far side of the fringe is hidden by the forehead when the head turns
        const nz = orient([Math.sin(x0 * kx), 0.3, Math.cos(x0 * kx)], o)[2];
        if (nz < 0.04) continue;
        const long = h2 > 0.8 ? 1.4 : 1;
        const len = (0.05 + h3 * 0.032) * F.bangs * long;
        const rootY = 0.092 - Math.abs(x0) * 0.3;
        const tipX = x0 * 1.12 + (h4 - 0.5) * 0.02;
        const pts: Vec2[] = [];
        const N = 6;
        for (let k = 0; k < N; k++) {
          const f = k / (N - 1);
          const y = rootY - len * f;
          const x = lerp(x0, tipX, f * f);
          const q = pj([x, y, faceFrontZ(F, x, y) + 0.006 + 0.008 * (1 - f)]);
          pts.push({ x: q.x + swx * f * f, y: q.y + swy * f * f });
        }
        const w0 = 0.015 * s * (0.75 + h1 * 0.5);
        // soft shadow the lock casts on the forehead (away from the key light)
        ribbon(
          P,
          pts.map((p, k) => ({ x: p.x - L.side * 0.006 * s * (k / (N - 1)), y: p.y + 0.006 * s * vk })),
          w0 * 1.3,
          w0 * 0.3,
        );
        P.fill({ color: mix(C.skinShadow, [0, 0, 0], 0.55), density: 0.1, alpha: 0.4 * A * W.bangs * W.relief });
        ribbon(P, pts, w0, 0.0015 * s);
        P.fill(paint(h3 > 0.6 ? hairMid : hairDark, A * W.bangs));
        if (h4 > 0.62 && W.fineHair > 0.01) {
          ribbon(P, pts.slice(0, 5), w0 * 0.28, 0.001 * s);
          P.fill(paint(hairSheen, A * W.fineHair * W.bangs));
        }
      }
    }
    // flyaway hairs off the silhouette (upper half)
    if (W.fineHair > 0.01) {
      for (let i = 0; i < rough.length; i += 4) {
        const p = rough[i];
        if (p.y > hc.y + 0.02 * s * vk || hashf(seed, i, 51) > 0.6) continue;
        const dx = p.x - hc.x;
        const dy = p.y - hc.y;
        const l = Math.hypot(dx, dy) || 1;
        const len = (0.025 + hashf(seed, i, 52) * 0.04) * s;
        P.beginPath();
        P.moveTo(p.x - (dx / l) * 0.01 * s, p.y - (dy / l) * 0.01 * s);
        P.quadTo(
          p.x + (dx / l) * len * 0.6,
          p.y + (dy / l) * len * 0.4,
          p.x + (dx / l) * len + (hashf(seed, i, 53) - 0.5) * 0.02 * s,
          p.y + (dy / l) * len * 0.8 + 0.01 * s,
        );
        P.stroke(paint(hairDark, 0.75 * A * W.fineHair), Math.max(0.6, 0.004 * s));
      }
    }
    // rim light on the hair silhouette (far shots)
    // extreme close-up: individual fine hairs over the mass
    if (W.ecu > 0.01) {
      for (let si = 0; si < strands.length; si++) {
        if (strands[si].kind === 'bang' || strands[si].kind === 'crown') continue;
        const pts = strandPts[si];
        for (let k = 0; k < 3; k++) {
          const off = (hashf(seed, si, k, 61) - 0.5) * 0.05 * s;
          const lenF = 0.55 + hashf(seed, si, k, 62) * 0.4;
          const pp = pts.map((p, j) => {
            const f = j / (pts.length - 1);
            return { x: pts[0].x + (p.x - pts[0].x) * lerp(1, lenF, f) + off * (0.2 + f), y: pts[0].y + (p.y - pts[0].y) * lerp(1, lenF, f) };
          });
          P.beginPath();
          P.smoothPath(pp, false, 0.5);
          P.stroke(paint(k === 0 ? hairSheen : hairDark, 0.55 * A * W.ecu), Math.max(0.5, 0.0025 * s));
        }
      }
    }
    // tiny figures: closed contour around the head, matching the cloak's
    if (W.silhouette > 0.02) {
      P.beginPath();
      P.smoothPath(rough, true, 0.35);
      P.stroke({ color: L.rimColor, density: 0.85, alpha: 0.75 * W.silhouette * A }, 2 + 3 * W.silhouette);
    }
    // rim light on the hair silhouette (strongest on small, far figures)
    const rimHair = Math.max(W.silhouette, 1 - W.features);
    if (L.rim > 0 && rimHair > 0.01) {
      const rimPts = rough.filter((p) => (p.x - hc.x) * L.side > 0 && p.y < hc.y);
      if (rimPts.length > 1) {
        rimPts.sort((a, b) => a.y - b.y);
        P.beginPath();
        P.smoothPath(rimPts, false, 0.5);
        P.stroke({ color: L.rimColor, density: 0.75, alpha: 0.5 * L.rim * A * rimHair }, Math.max(1 + W.silhouette, 0.015 * s));
      }
    }
  }
}
