import { clamp, lerp, rot, type Vec2 } from '../core/math';
import { noise1 } from '../core/noise';
import type { CharacterDef, Pose } from '../character/types';
import { makeHair, orient, type HeadOrient, type StrandRest } from '../character/head';
import { computePose, PREROLL, type LocoTrack } from './locomotion';
import { Verlet } from './verlet';

export type SimView = 'side' | 'front' | 'back';
/** Horizontal wind velocity (m/s) in the simulation plane at time t, plane-x and height y. */
export type WindFn = (t: number, x: number, y: number) => number;

export const SIM_HZ = 120;
const CHECKPOINT_EVERY = 60;
const SIDE_NC = 7;
const FRONT_NC = 9;
const NR = 14;
const HAIR_PTS = 7;
const HAIR_PINNED = 3;

interface Capsule {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
}

/** Horizontal extent [min,max] of a set of capsules at height y (or null). */
function extentsAt(caps: Capsule[], y: number): [number, number] | null {
  let mn = Infinity;
  let mx = -Infinity;
  for (const c of caps) {
    for (let k = 0; k <= 6; k++) {
      const f = k / 6;
      const px = c.ax + (c.bx - c.ax) * f;
      const py = c.ay + (c.by - c.ay) * f;
      const dy = Math.abs(py - y);
      if (dy >= c.r) continue;
      const h = Math.sqrt(c.r * c.r - dy * dy);
      if (px - h < mn) mn = px - h;
      if (px + h > mx) mx = px + h;
    }
  }
  return mn === Infinity ? null : [mn, mx];
}

/** Map look yaw (-1 back … 0 forward … 1 camera) onto a face angle for the given base view. */
export function faceAngle(view: SimView, yaw: number): number {
  const B = view === 'side' ? Math.PI / 2 : view === 'front' ? 0 : Math.PI;
  if (view === 'side') return yaw >= 0 ? B * (1 - 0.82 * yaw) : B - 2 * B * -yaw;
  if (view === 'front') return yaw >= 0 ? 0 : 1.9 * -yaw;
  return yaw >= 0 ? Math.PI - 1.4 * yaw : Math.PI + 1.2 * yaw;
}

export function headOrientFor(view: SimView, pose: Pose): HeadOrient {
  return { yaw: faceAngle(view, pose.headYaw), pitch: pose.headPitch, tilt: pose.headTilt + (view === 'side' ? 0 : pose.sway * 0.6) };
}

/** Head centre in the sim plane. */
export function headCenter(view: SimView, pose: Pose): Vec2 {
  if (view === 'side') return pose.head;
  return { x: pose.sway * 0.55, y: pose.head.y };
}

/**
 * Secondary motion for one actor: cloak cloth + hair strands, simulated at a
 * fixed 120 Hz from the pre-roll. State at any time t is reproducible: seeking
 * restores the nearest checkpoint and re-simulates forward.
 */
export class CharacterSim {
  readonly view: SimView;
  readonly nc: number;
  readonly nr = NR;
  readonly cloak: Verlet;
  readonly hair: Verlet;
  readonly strands: StrandRest[];
  readonly def: CharacterDef;
  private track: LocoTrack;
  private wind: WindFn;
  private seed: number;
  private step = -1;
  private checkpoints = new Map<number, Float64Array[]>();
  private t0: number;
  pose!: Pose;

  constructor(def: CharacterDef, track: LocoTrack, view: SimView, wind: WindFn, seed: number) {
    this.def = def;
    this.track = track;
    this.view = view;
    this.wind = wind;
    this.seed = seed;
    this.t0 = -PREROLL;
    this.nc = view === 'side' ? SIDE_NC : FRONT_NC;
    this.cloak = new Verlet(this.nc * NR);
    this.strands = makeHair(def.hair.strands, def.hair.length, seed);
    this.hair = new Verlet(this.strands.length * HAIR_PTS);
    this.init();
  }

  get time() {
    return this.t0 + this.step / SIM_HZ;
  }

  idx(r: number, c: number) {
    return r * this.nc + c;
  }

  /** Pinned yoke (rows 0..1) for the current pose. */
  private yoke(pose: Pose): Vec2[][] {
    const rows: Vec2[][] = [[], []];
    const nc = this.nc;
    if (this.view === 'side') {
      const L = -pose.lean;
      const n = pose.neck;
      const c = pose.chest;
      for (let i = 0; i < nc; i++) {
        const s = i / (nc - 1); // 0 = front, 1 = back
        const o0 = rot({ x: lerp(0.06, -0.08, s), y: -0.035 + 0.03 * Math.sin(Math.PI * s) }, L);
        rows[0].push({ x: n.x + o0.x, y: n.y + o0.y });
        const o1 = rot({ x: lerp(0.115, -0.155, s), y: -0.03 + 0.06 * Math.sin(Math.PI * Math.pow(s, 0.8)) }, L);
        // shoulder counter-rotation carries the yoke a little (front edge most)
        const sh = (pose.shoulders.x - (c.x - 0.01)) * (1 - 0.6 * s);
        rows[1].push({ x: c.x + o1.x + sh, y: c.y + o1.y });
      }
    } else {
      const cx = pose.sway * 0.5;
      for (let i = 0; i < nc; i++) {
        const s = (i / (nc - 1)) * 2 - 1; // -1 left … 1 right
        rows[0].push({ x: cx + s * 0.085, y: pose.neck.y - 0.03 + 0.012 * (1 - s * s) });
        rows[1].push({ x: cx + s * 0.215, y: pose.chest.y + 0.03 - 0.055 * s * s });
      }
    }
    return rows;
  }

  private bodyCaps(pose: Pose): Capsule[] {
    const P = this.def.proportions;
    if (this.view === 'side') {
      const caps: Capsule[] = [
        { ax: pose.hip.x, ay: pose.hip.y, bx: pose.chest.x, by: pose.chest.y, r: 0.13 },
        { ax: pose.hip.x - 0.02, ay: pose.hip.y - 0.02, bx: pose.hip.x + 0.01, by: pose.hip.y + 0.1, r: 0.12 },
      ];
      for (let k = 0; k < 2; k++) {
        caps.push({ ax: pose.hip.x, ay: pose.hip.y, bx: pose.knees[k].x, by: pose.knees[k].y, r: 0.085 });
        caps.push({ ax: pose.knees[k].x, ay: pose.knees[k].y, bx: pose.feet[k].ankle.x, by: pose.feet[k].ankle.y, r: 0.065 });
        caps.push({ ax: pose.shoulders.x, ay: pose.shoulders.y, bx: pose.elbows[k].x, by: pose.elbows[k].y, r: 0.06 });
        caps.push({ ax: pose.elbows[k].x, ay: pose.elbows[k].y, bx: pose.hands[k].x, by: pose.hands[k].y, r: 0.055 });
      }
      return caps;
    }
    const sx = pose.sway;
    const caps: Capsule[] = [{ ax: sx, ay: pose.hip.y, bx: sx * 0.5, by: pose.chest.y, r: 0.15 }];
    for (const s of [-1, 1]) {
      caps.push({ ax: sx + s * 0.1, ay: pose.hip.y, bx: s * 0.1 + sx * 0.3, by: P.ankleH, r: 0.08 });
      caps.push({ ax: sx * 0.5 + s * 0.19, ay: pose.chest.y - 0.02, bx: sx * 0.6 + s * 0.235, by: pose.hip.y - 0.1, r: 0.06 });
    }
    return caps;
  }

  private init() {
    const pose = computePose(this.track, this.t0, this.seed);
    this.pose = pose;
    const yoke = this.yoke(pose);
    const nc = this.nc;
    const V = this.cloak;
    const hemY = this.def.cloak.hemLift;
    const flare = this.view === 'side' ? this.def.cloak.hemFlare : this.def.cloak.hemFlare * 1.2;
    const w1 = Math.abs(yoke[1][0].x - yoke[1][nc - 1].x);
    const c1 = (yoke[1][0].x + yoke[1][nc - 1].x) / 2;
    const y1 = Math.min(...yoke[1].map((p) => p.y));
    for (let r = 0; r < NR; r++) {
      for (let c = 0; c < nc; c++) {
        const i = this.idx(r, c);
        if (r < 2) {
          V.set(i, yoke[r][c].x, yoke[r][c].y);
          V.pinned[i] = 1;
          continue;
        }
        const f = (r - 1) / (NR - 2);
        const w = lerp(w1, flare, Math.pow(f, 0.85));
        const cx = lerp(c1, this.view === 'side' ? pose.hip.x - 0.035 : pose.sway, f);
        const s = c / (nc - 1);
        const x = this.view === 'side' ? cx + (0.5 - s) * w : cx + (s - 0.5) * w;
        V.set(i, x, lerp(y1, hemY, f));
      }
    }
    for (let r = 0; r < NR; r++) {
      for (let c = 0; c < nc; c++) {
        const i = this.idx(r, c);
        if (r + 1 < NR) V.link(i, this.idx(r + 1, c), 1);
        if (c + 1 < nc) V.link(i, this.idx(r, c + 1), r < 2 ? 1 : 0.55);
        if (r + 1 < NR && c + 1 < nc) {
          V.link(i, this.idx(r + 1, c + 1), 0.25);
          V.link(this.idx(r, c + 1), this.idx(r + 1, c), 0.25);
        }
        if (r + 2 < NR) V.link(i, this.idx(r + 2, c), 0.3);
      }
    }
    // hair
    const H = this.hair;
    const hc = headCenter(this.view, pose);
    const o = headOrientFor(this.view, pose);
    this.strands.forEach((st, si) => {
      for (let k = 0; k < HAIR_PTS; k++) {
        const p = orient(st.pts[k], o);
        const i = si * HAIR_PTS + k;
        H.set(i, hc.x + p[0], hc.y + p[1]);
        if (k < HAIR_PINNED) H.pinned[i] = 1;
        if (k > 0) H.link(i - 1, i, 1);
      }
    });
    this.step = 0;
    this.checkpoints.set(0, [V.snapshot(), H.snapshot()]);
  }

  private doStep() {
    const dt = 1 / SIM_HZ;
    const t = this.t0 + (this.step + 1) / SIM_HZ;
    const pose = computePose(this.track, t, this.seed);
    this.pose = pose;
    const V = this.cloak;
    const nc = this.nc;
    const yoke = this.yoke(pose);
    for (let r = 0; r < 2; r++) for (let c = 0; c < nc; c++) V.pin(this.idx(r, c), yoke[r][c].x, yoke[r][c].y);
    const wind = this.wind;
    const seed = this.seed;
    // secondary motion: lower drag and softer hair follow = more inertia/lag
    const sec = Math.max(0.3, this.track.actor.gait?.secondary ?? 1);
    V.integrate(dt, 1 - 0.004 / sec, (i, vx, vy, out) => {
      const r = Math.floor(i / nc);
      const f = r / (NR - 1);
      const w = wind(t, V.x[i], V.y[i]);
      const kw = 1.4 * (0.35 + 0.65 * f);
      out[0] = kw * (w - vx);
      out[1] = -9.81 + Math.abs(w - vx) * 0.35 * f * (1 + noise1(t * 2.3 + i * 0.37, seed));
      out[1] -= vy * 0.4;
    });
    const caps = this.bodyCaps(pose);
    const hemLiftMin = new Float64Array(nc);
    if (this.view !== 'side') {
      for (let c = 0; c < nc; c++) {
        const i = this.idx(NR - 1, c);
        let m = 0;
        for (let k = 0; k < 2; k++) {
          const legX = pose.sway + (k === 0 ? 0.1 : -0.1);
          const ft = pose.feet[k];
          const lift = (ft.ankle.y - this.def.proportions.ankleH) * 1.5 + Math.max(0, ft.ankle.x - pose.hip.x) * 0.2;
          const g = Math.exp(-Math.pow((V.x[i] - legX) / 0.13, 2));
          m = Math.max(m, lift * g);
        }
        hemLiftMin[c] = m;
      }
    }
    for (let it = 0; it < 10; it++) {
      V.solve();
      for (let r = 2; r < NR; r++) {
        const iF = this.idx(r, 0);
        const iB = this.idx(r, nc - 1);
        const e = extentsAt(caps, V.y[iF]);
        const e2 = extentsAt(caps, V.y[iB]);
        if (this.view === 'side') {
          if (e && V.x[iF] < e[1] + 0.015) V.x[iF] = e[1] + 0.015;
          if (e2 && V.x[iB] > e2[0] - 0.02) V.x[iB] = e2[0] - 0.02;
          // keep interior columns between the edges
          const xf = V.x[iF];
          const xb = V.x[iB];
          for (let c = 1; c < nc - 1; c++) {
            const i = this.idx(r, c);
            V.x[i] = clamp(V.x[i], xb, xf);
          }
        } else {
          if (e && V.x[iF] > e[0] - 0.015) V.x[iF] = e[0] - 0.015;
          if (e2 && V.x[iB] < e2[1] + 0.015) V.x[iB] = e2[1] + 0.015;
          const xl = V.x[iF];
          const xr = V.x[iB];
          for (let c = 1; c < nc - 1; c++) {
            const i = this.idx(r, c);
            V.x[i] = clamp(V.x[i], xl, xr);
          }
        }
        for (let c = 0; c < nc; c++) {
          const i = this.idx(r, c);
          const minY = 0.004 + (r >= NR - 3 && this.view !== 'side' ? hemLiftMin[c] * (1 - (NR - 1 - r) * 0.3) : 0);
          if (V.y[i] < minY) {
            V.y[i] = minY;
            V.px[i] = V.x[i] - (V.x[i] - V.px[i]) * 0.5;
          }
        }
      }
    }
    // hair
    const H = this.hair;
    const hc = headCenter(this.view, pose);
    const o = headOrientFor(this.view, pose);
    const proj = this.strands.map((st) => st.pts.map((p) => orient(p, o)));
    for (let si = 0; si < this.strands.length; si++) {
      for (let k = 0; k < HAIR_PINNED; k++) {
        const p = proj[si][k];
        H.pin(si * HAIR_PTS + k, hc.x + p[0], hc.y + p[1]);
      }
    }
    H.integrate(dt, 0.985, (i, vx, vy, out) => {
      const si = Math.floor(i / HAIR_PTS);
      const w = wind(t, H.x[i], H.y[i]) * (1 + 0.6 * noise1(t * 1.7 + si * 1.3, seed + 3));
      out[0] = 2.2 * (w - vx);
      out[1] = -9.81 * 0.45 - vy * 0.8;
    });
    for (let it = 0; it < 4; it++) {
      for (let si = 0; si < this.strands.length; si++) {
        for (let k = HAIR_PINNED; k < HAIR_PTS; k++) {
          const i = si * HAIR_PTS + k;
          const p = proj[si][k];
          const tx = hc.x + p[0];
          const ty = hc.y + p[1];
          const ks = (0.09 * (1 - (k - HAIR_PINNED) / (HAIR_PTS - HAIR_PINNED)) + 0.02) / sec;
          H.x[i] += (tx - H.x[i]) * ks;
          H.y[i] += (ty - H.y[i]) * ks;
        }
      }
      // projected rest lengths (view angle changes them)
      let ci = 0;
      for (let si = 0; si < this.strands.length; si++) {
        for (let k = 1; k < HAIR_PTS; k++) {
          const a = proj[si][k - 1];
          const b = proj[si][k];
          H.setRest(ci++, Math.hypot(a[0] - b[0], a[1] - b[1]));
        }
      }
      H.solve();
    }
    this.step++;
    if (this.step % CHECKPOINT_EVERY === 0 && !this.checkpoints.has(this.step)) {
      this.checkpoints.set(this.step, [V.snapshot(), H.snapshot()]);
    }
  }

  /** Advance or rewind the simulation so that it represents time t. */
  ensure(t: number) {
    const target = Math.max(0, Math.round((t - this.t0) * SIM_HZ));
    if (target < this.step) {
      let best = 0;
      for (const k of this.checkpoints.keys()) if (k <= target && k > best) best = k;
      const snap = this.checkpoints.get(best)!;
      this.cloak.restore(snap[0]);
      this.hair.restore(snap[1]);
      this.step = best;
    } else if (target - this.step > CHECKPOINT_EVERY) {
      // jump forward via the furthest checkpoint we already have
      let best = this.step;
      for (const k of this.checkpoints.keys()) if (k <= target && k > best) best = k;
      if (best > this.step) {
        const snap = this.checkpoints.get(best)!;
        this.cloak.restore(snap[0]);
        this.hair.restore(snap[1]);
        this.step = best;
      }
    }
    while (this.step < target) this.doStep();
    // the pose always matches t exactly (cloth state is at the nearest 1/120 s step)
    this.pose = computePose(this.track, t, this.seed);
  }

  hairStrandPoints(si: number): Vec2[] {
    const pts: Vec2[] = [];
    for (let k = 0; k < HAIR_PTS; k++) {
      const i = si * HAIR_PTS + k;
      pts.push({ x: this.hair.x[i], y: this.hair.y[i] });
    }
    return pts;
  }
}
