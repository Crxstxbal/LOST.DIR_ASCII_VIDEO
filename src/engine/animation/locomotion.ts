import { clamp, lerp, minJerk, smoothstep, TAU } from '../core/math';
import { hashf } from '../core/rng';
import { noise1 } from '../core/noise';
import { ik2 } from '../core/math';
import type { ActorParams, LookTarget } from '../project/schema';
import type { CharacterDef, FootState, Pose } from '../character/types';

/**
 * Locomotion is precomputed into a deterministic track sampled at 120 Hz:
 * distance, gait phase and foot-plant events. Feet are locked to their plant
 * positions in world space while in stance, so they can never slide.
 */
export const TRACK_HZ = 120;
const MODE_WALK = 0;
const MODE_SETTLE = 1;
const MODE_IDLE = 2;
const SETTLE_DUR = 1.25;
/** Seconds simulated before t=0 so secondary motion is already settled on the first frame. */
export const PREROLL = 1.5;

export interface FootEvent {
  /** Heel-strike time. */
  t: number;
  /** Plant position (ankle u). */
  u: number;
  /** Lift-off time (Infinity while planted). */
  lift: number;
}

export interface LocoTrack {
  t0: number;
  n: number;
  dist: Float64Array;
  phase: Float64Array;
  vel: Float32Array;
  mode: Uint8Array;
  settle: Float32Array;
  feet: [FootEvent[], FootEvent[]];
  stepLen: (v: number) => number;
  def: CharacterDef;
  actor: ActorParams;
}

/**
 * Gait parameters (per actor). 'v2' is the hand-keyed 12-pose walk; 'v1' is the
 * original procedural walk, kept for the comparison scene.
 */
export interface GaitParams {
  style: 'v1' | 'v2';
  /** Step length multiplier. */
  stride: number;
  /** Vertical body motion (down / up poses). */
  bob: number;
  /** Arm and shoulder swing (under the cloak) and torso counter-rotation. */
  swing: number;
  /** Secondary motion of cloak and hair (inertia / lag). */
  secondary: number;
}

export const DEFAULT_GAIT: GaitParams = { style: 'v2', stride: 1, bob: 1, swing: 1, secondary: 1 };

export const GAIT_PARAM_DEFS: { key: Exclude<keyof GaitParams, 'style'>; label: string; min: number; max: number; step: number }[] = [
  { key: 'stride', label: 'Longitud de paso', min: 0.6, max: 1.5, step: 0.01 },
  { key: 'bob', label: 'Subida y bajada del cuerpo', min: 0, max: 2, step: 0.01 },
  { key: 'swing', label: 'Balanceo (brazos y hombros)', min: 0, max: 2, step: 0.01 },
  { key: 'secondary', label: 'Movimiento secundario (capa y pelo)', min: 0.3, max: 2, step: 0.01 },
];

export function resolveGait(actor: ActorParams): GaitParams {
  return { ...DEFAULT_GAIT, ...(actor.gait ?? {}) };
}

export function stepLenFor(def: CharacterDef, v: number, stride = 1) {
  return (def.walk.stepLenBase + def.walk.stepLenPerSpeed * clamp(v, 0, 1.6)) * stride;
}

/** Monotone (no overshoot) cubic interpolation through [x, y] keys, x ascending. */
export function keyed(keys: number[][], x: number): number {
  const n = keys.length;
  if (x <= keys[0][0]) return keys[0][1];
  if (x >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0;
  while (keys[i + 1][0] < x) i++;
  const [x0, y0] = keys[i];
  const [x1, y1] = keys[i + 1];
  const h = x1 - x0;
  const d = (y1 - y0) / h;
  const slope = (j: number) => {
    if (j <= 0 || j >= n - 1) return j <= 0 ? (keys[1][1] - keys[0][1]) / (keys[1][0] - keys[0][0]) : (keys[n - 1][1] - keys[n - 2][1]) / (keys[n - 1][0] - keys[n - 2][0]);
    const a = (keys[j][1] - keys[j - 1][1]) / (keys[j][0] - keys[j - 1][0]);
    const b = (keys[j + 1][1] - keys[j][1]) / (keys[j + 1][0] - keys[j][0]);
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  };
  let m0 = slope(i);
  let m1 = slope(i + 1);
  if (d === 0) m0 = m1 = 0;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1;
}

/*
 * The v2 cycle, 12 key poses per full cycle (6 per step), keyed in the phase of
 * each leg (0 = its heel strike) and of the body's half-cycle:
 *   contact · down · passing · up · high · (other leg) contact … for the body;
 *   toe-off · recoil (foot kicks up behind) · passing (knee high) · reach · strike
 *   for the swinging leg. Stance stays locked to the ground (no sliding).
 */
// swing leg, by swing progress s (0 = toe-off, 1 = heel strike)
const SW_X = [[0, 0], [0.2, 0.08], [0.45, 0.42], [0.72, 0.86], [0.9, 0.985], [1, 1]];
const SW_Y = [[0, 0], [0.18, 0.78], [0.42, 1], [0.7, 0.52], [0.9, 0.12], [1, 0]];
const SW_A = [[0, -0.5], [0.2, -0.68], [0.45, -0.26], [0.74, 0.12], [1, 0.22]];
// body height over a half cycle (0 = a heel strike): contact, down, passing, up/high, falling
const BOB = [[0, -0.25], [0.12, -1], [0.3, -0.15], [0.52, 0.8], [0.64, 1], [0.84, 0.3], [1, -0.25]];
/** Body speed surge within a step (slower after contact, faster through passing). */
const SURGE = 0.06;

export function buildTrack(def: CharacterDef, actor: ActorParams, duration: number): LocoTrack {
  const dt = 1 / TRACK_HZ;
  const t0 = -PREROLL;
  const n = Math.ceil((duration + 2 + PREROLL) * TRACK_HZ) + 1;
  const dist = new Float64Array(n);
  const phase = new Float64Array(n);
  const vel = new Float32Array(n);
  const mode = new Uint8Array(n);
  const settle = new Float32Array(n);
  const duty = def.walk.duty;
  const G = resolveGait(actor);
  const L = (v: number) => stepLenFor(def, v, G.stride);
  const surge = G.style === 'v2' ? SURGE : 0;
  const feet: [FootEvent[], FootEvent[]] = [[], []];

  const loco = actor.actions.filter((a) => a.type === 'walk' || a.type === 'stop').sort((a, b) => a.t - b.t);
  let ai = 0;

  let d = actor.start;
  let v = 0;
  let ph = 0;
  let m = MODE_IDLE;
  let target = 0;
  let stopRequested = -1;
  let settleStart = 0;
  let settleFrom = 0;
  let settleTo = 0;
  const walking0 = actor.startWalking && actor.speed > 0.01;
  if (walking0) {
    // already walking during the pre-roll: position at t0 so that dist(0) = start
    v = actor.speed;
    target = actor.speed;
    m = MODE_WALK;
    d = actor.start + v * t0;
    const l = L(v);
    const cyc = (2 * l) / v; // seconds per gait cycle
    // foot 0 strikes at t0 (phase 0); foot 1 struck half a cycle earlier.
    feet[0].push({ t: t0 - cyc, u: d - 2 * l + duty * l, lift: t0 - cyc + duty * cyc });
    feet[0].push({ t: t0, u: d + duty * l, lift: Infinity });
    feet[1].push({ t: t0 - cyc / 2, u: d - l + duty * l, lift: t0 - cyc / 2 + duty * cyc });
    ph = 0;
  } else {
    feet[0].push({ t: t0 - 10, u: d + 0.07, lift: Infinity });
    feet[1].push({ t: t0 - 10, u: d - 0.07, lift: Infinity });
  }

  const latest = (k: number) => feet[k][feet[k].length - 1];

  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    // --- actions ---
    while (ai < loco.length && loco[ai].t <= t) {
      const a = loco[ai++];
      if (a.type === 'walk') {
        target = a.speed ?? actor.speed;
        stopRequested = -1;
        if (m === MODE_IDLE || m === MODE_SETTLE) {
          // start walking: the rear foot lifts first
          const kb = latest(0).u <= latest(1).u ? 0 : 1;
          ph = duty + 0.5 * kb;
          latest(kb).lift = t;
          m = MODE_WALK;
        }
      } else if (a.type === 'stop' && m === MODE_WALK) {
        stopRequested = t;
      }
    }

    // --- integrate ---
    if (m === MODE_WALK) {
      const tgt = stopRequested >= 0 ? Math.max(0.12, target * 0.55) : target;
      const tau = v < tgt ? (v < 0.05 ? 0.35 : def.walk.accelTime / 3) : 0.6;
      v += (tgt - v) * (dt / tau);
      const l = L(v);
      const prevPh = ph;
      ph += (v / (2 * l)) * dt;
      // weight transfer: the body slows after each contact and speeds up through
      // passing (mean speed unchanged). Plants are taken from d, so no foot slides.
      d += v * dt * (1 - surge * Math.cos(TAU * 2 * (ph - 0.1)));
      for (let k = 0; k < 2; k++) {
        const a0 = prevPh - 0.5 * k;
        const a1 = ph - 0.5 * k;
        if (Math.floor(a1) > Math.floor(a0)) {
          // heel strike for foot k
          latest(k).lift = Math.min(latest(k).lift, t);
          feet[k].push({ t, u: d + duty * l, lift: Infinity });
          if (stopRequested >= 0 && t - stopRequested > 0.3) {
            m = MODE_SETTLE;
            settleStart = t;
            settleFrom = d;
            settleTo = d + duty * l - 0.05;
            const kb = 1 - k;
            const back = latest(kb);
            if (back.lift === Infinity) back.lift = t + SETTLE_DUR * 0.18;
            feet[kb].push({ t: t + SETTLE_DUR * 0.78, u: d + duty * l - 0.12, lift: Infinity });
            stopRequested = -1;
          }
        }
        const f0 = a0 - Math.floor(a0);
        const f1 = a1 - Math.floor(a1);
        if (m === MODE_WALK && f0 < duty && f1 >= duty && Math.floor(a1) === Math.floor(a0)) {
          if (latest(k).lift === Infinity) latest(k).lift = t;
        }
      }
    } else if (m === MODE_SETTLE) {
      const p = clamp((t - settleStart) / SETTLE_DUR);
      const nd = lerp(settleFrom, settleTo, minJerk(p));
      v = (nd - d) / dt;
      d = nd;
      if (p >= 1) {
        m = MODE_IDLE;
        v = 0;
      }
    } else {
      v = 0;
    }
    dist[i] = d;
    phase[i] = ph;
    vel[i] = v;
    mode[i] = m;
    settle[i] = m === MODE_SETTLE ? clamp((t - settleStart) / SETTLE_DUR) : m === MODE_IDLE ? 1 : 0;
  }
  return { t0, n, dist, phase, vel, mode, settle, feet, stepLen: L, def, actor };
}

export function sampleTrack(tr: LocoTrack, t: number) {
  const f = clamp((t - tr.t0) * TRACK_HZ, 0, tr.n - 1);
  const i = Math.min(tr.n - 2, Math.floor(f));
  const a = f - i;
  return {
    dist: lerp(tr.dist[i], tr.dist[i + 1], a),
    phase: lerp(tr.phase[i], tr.phase[i + 1], a),
    v: lerp(tr.vel[i], tr.vel[i + 1], a),
    mode: tr.mode[a < 0.5 ? i : i + 1],
    settle: lerp(tr.settle[i], tr.settle[i + 1], a),
  };
}

const STRIKE_ANGLE = 0.22; // toe up at heel strike
const LIFT_ANGLE = -0.5; // toe down at toe-off
const HEEL_RISE = 0.22; // seconds of heel rise before lift-off
const STRIKE_ROLL = 0.12; // seconds to roll flat after strike

/** Rigid foot from a pivot. θ>0 = toe up. Heel/toe/ankle in heading space. */
function footFromHeel(P: CharacterDef['proportions'], hx: number, hy: number, th: number) {
  const fx = Math.cos(th);
  const fy = Math.sin(th);
  const nx = -fy;
  const ny = fx;
  const heel = { x: hx, y: hy };
  return {
    heel,
    toe: { x: hx + fx * P.footLen, y: hy + fy * P.footLen },
    ankle: { x: hx + fx * P.heelBack + nx * P.ankleH, y: hy + fy * P.heelBack + ny * P.ankleH },
  };
}
function footFromToe(P: CharacterDef['proportions'], tx: number, ty: number, th: number) {
  return footFromHeel(P, tx - Math.cos(th) * P.footLen, ty - Math.sin(th) * P.footLen, th);
}
function footFromAnkle(P: CharacterDef['proportions'], ax: number, ay: number, th: number) {
  const fx = Math.cos(th);
  const fy = Math.sin(th);
  const nx = -fy;
  const ny = fx;
  return footFromHeel(P, ax - fx * P.heelBack - nx * P.ankleH, ay - fy * P.heelBack - ny * P.ankleH, th);
}

/** Stance foot for a plant event at time t (heel strike → flat → heel rise around the toe). */
function stanceFoot(P: CharacterDef['proportions'], e: FootEvent, t: number) {
  const since = t - e.t;
  const toLift = e.lift === Infinity ? Infinity : e.lift - t;
  const hx = e.u - P.heelBack; // plant is defined so that a flat foot has its ankle at e.u
  if (toLift < HEEL_RISE) {
    const h = clamp(1 - toLift / HEEL_RISE);
    const th = LIFT_ANGLE * h * h;
    return { ...footFromToe(P, hx + P.footLen, 0, th), angle: th };
  }
  const th = since < STRIKE_ROLL ? STRIKE_ANGLE * (1 - smoothstep(0, STRIKE_ROLL, since)) : 0;
  return { ...footFromHeel(P, hx, 0, th), angle: th };
}

/** Foot state at time t (heading space). */
export function footAt(tr: LocoTrack, k: number, t: number): FootState {
  const def = tr.def;
  const P = def.proportions;
  const ev = tr.feet[k];
  // last event whose strike time <= t
  let i = ev.length - 1;
  while (i > 0 && ev[i].t > t) i--;
  const e = ev[i];
  const next = ev[i + 1];
  if (t < e.lift || !next) {
    const f = stanceFoot(P, e, t);
    return { ankle: f.ankle, heel: f.heel, toe: f.toe, angle: f.angle, planted: true };
  }
  // swing: from the exact lift-off pose to the exact heel-strike pose (no pops)
  const a0 = stanceFoot(P, e, e.lift).ankle;
  const a1 = footFromHeel(P, next.u - P.heelBack, 0, STRIKE_ANGLE).ankle;
  const s = clamp((t - e.lift) / Math.max(0.05, next.t - e.lift));
  if (resolveGait(tr.actor).style === 'v2') {
    // keyed arc: recoil behind, knee drives through passing, leg reaches, heel strikes
    const lift = def.walk.lift * 1.15 * (0.55 + 0.45 * clamp(Math.abs(next.u - e.u) / 0.9));
    const ax = lerp(a0.x, a1.x, keyed(SW_X, s));
    const ay = lerp(a0.y, a1.y, s) + lift * keyed(SW_Y, s);
    const th = keyed(SW_A, s);
    let f = footFromAnkle(P, ax, ay, th);
    // toe/heel never dip below the ground
    const low = Math.min(f.toe.y, f.heel.y);
    if (low < 0) f = footFromAnkle(P, ax, ay - low, th);
    return { ankle: f.ankle, heel: f.heel, toe: f.toe, angle: th, planted: false, swing: s };
  }
  const ms = minJerk(s);
  const lift = def.walk.lift * (0.55 + 0.45 * clamp(Math.abs(next.u - e.u) / 0.9));
  const ax = lerp(a0.x, a1.x, ms);
  const ay = lerp(a0.y, a1.y, ms) + lift * Math.sin(Math.PI * Math.pow(s, 0.8));
  const th = lerp(LIFT_ANGLE, STRIKE_ANGLE, smoothstep(0.05, 0.92, s));
  const f = footFromAnkle(P, ax, ay, th);
  return { ankle: f.ankle, heel: f.heel, toe: f.toe, angle: th, planted: false };
}

/** Head look targets from the action list, blended smoothly. */
function lookAt(actor: ActorParams, t: number) {
  const looks = actor.actions.filter((a) => a.type === 'look').sort((a, b) => a.t - b.t);
  const val = (l: LookTarget | undefined) => {
    switch (l) {
      case 'up':
        return { pitch: 0.55, yaw: 0, tilt: 0 };
      case 'down':
        return { pitch: -0.35, yaw: 0, tilt: 0 };
      case 'back':
        return { pitch: 0.02, yaw: -1, tilt: 0 };
      case 'camera':
        return { pitch: 0.04, yaw: 1, tilt: 0 };
      case 'tilt':
        return { pitch: -0.05, yaw: 0.25, tilt: 0.22 };
      default:
        return { pitch: 0, yaw: 0, tilt: 0 };
    }
  };
  let cur = val('forward');
  for (const a of looks) {
    if (a.t > t) break;
    const nv = val(a.look);
    const k = smoothstep(a.t, a.t + 1.4, t);
    cur = { pitch: lerp(cur.pitch, nv.pitch, k), yaw: lerp(cur.yaw, nv.yaw, k), tilt: lerp(cur.tilt, nv.tilt, k) };
  }
  return cur;
}

/** Full skeleton pose at time t. Pure function of (track, t, seed). */
export function computePose(tr: LocoTrack, t: number, seed: number): Pose {
  const def = tr.def;
  const P = def.proportions;
  const s = sampleTrack(tr, t);
  const mode = s.mode === MODE_WALK ? 'walk' : s.mode === MODE_SETTLE ? 'settle' : 'idle';
  const vN = clamp(s.v / 0.75, 0, 1.5);
  const feet: [FootState, FootState] = [footAt(tr, 0, t), footAt(tr, 1, t)];
  const legLen = P.thigh + P.shin;
  const standH = legLen + P.ankleH - 0.025;

  // breathing (slow, ~0.24 Hz) and idle weight shift
  const breath = Math.sin(t * TAU * 0.24 + hashf(seed, 3) * 6);
  const idleK = mode === 'walk' ? 0 : s.settle;
  const weightShift = noise1(t * 0.18, seed + 11) * 0.012 * idleK;

  const G = resolveGait(tr.actor);
  const v2 = G.style === 'v2';
  // pelvis height: double bob per cycle, lowest just after each heel strike
  // v2: walk-related body motion fades out over the first half of the settle (v1
  // switched it off the instant the stop began → a visible hop)
  const walkW = clamp(s.v / 0.5, 0, 1);
  const bobW =
    s.mode === MODE_WALK ? walkW : v2 && s.mode === MODE_SETTLE ? clamp(sampleTrack(tr, t - s.settle * SETTLE_DUR - 0.02).v / 0.5, 0, 1) * (1 - smoothstep(0, 0.5, s.settle)) : 0;
  const half = s.phase * 2 - Math.floor(s.phase * 2);
  const bobK = v2 ? 0.5 - 0.5 * keyed(BOB, half) : 0.5 + 0.5 * Math.cos(TAU * 2 * (s.phase - 0.09));
  const bobAmp = def.walk.bob * bobW * (v2 ? G.bob * 1.1 : 1);
  // v2: slightly bent knees while walking (a heavier, grounded gait) — leaves room for
  // the double-support pose so the leg-reach limit rarely has to cut in
  let hipY = standH - bobAmp * bobK - (v2 ? 0.032 * bobW * G.stride : 0);
  if (mode === 'settle') hipY -= 0.03 * Math.sin(Math.PI * s.settle);
  hipY += breath * 0.0025 * idleK;
  let hipU = s.dist + weightShift;
  // reach limits from planted feet (prevents knee hyper-extension; creates natural dip)
  for (const f of feet) {
    const dx = f.ankle.x - hipU;
    const maxDy = Math.sqrt(Math.max(0.0001, (legLen * 0.995) ** 2 - dx * dx));
    if (f.planted) hipY = Math.min(hipY, f.ankle.y + maxDy);
    else if (v2 && f.swing !== undefined) {
      // the leg about to strike starts constraining the pelvis before contact, so the
      // reach limit eases in instead of snapping the hip down on the heel strike
      const w = smoothstep(0.55, 1, f.swing);
      const lim = Math.max(f.ankle.y, 0) + maxDy;
      if (lim < hipY) hipY = lerp(hipY, lim, w);
    }
  }
  const hip = { x: hipU, y: hipY };
  const knees = feet.map((f) => ik2(hip, f.ankle, P.thigh, P.shin, 1).joint) as [any, any];

  // torso: speed lean, push-off pulse, and (v2) lean into accelerations / back on braking
  let accelLean = 0;
  if (v2) {
    const a = (sampleTrack(tr, t + 0.06).v - sampleTrack(tr, t - 0.06).v) / 0.12;
    accelLean = clamp(a * 0.05, -0.05, 0.07);
  }
  const lean =
    def.walk.lean * vN +
    0.025 +
    (v2 ? 0.016 * Math.sin(TAU * 2 * (s.phase - 0.32)) : 0.012 * Math.sin(TAU * 2 * (s.phase - 0.15))) * bobW +
    accelLean +
    (mode === 'settle' ? 0.03 * Math.sin(Math.PI * s.settle) : 0);
  const chestLag = 0.006 * Math.cos(TAU * 2 * (s.phase - 0.2)) * bobW;
  const chest = { x: hip.x + Math.sin(lean) * P.spine, y: hip.y + Math.cos(lean) * P.spine - chestLag + breath * 0.004 };
  const neck = { x: chest.x + Math.sin(lean + 0.12) * P.neck, y: chest.y + Math.cos(lean + 0.12) * P.neck };

  // head: stabilised (counter-rotates the torso), melancholic downward tilt, look targets
  const look = lookAt(tr.actor, t);
  const drift = noise1(t * 0.31, seed + 5) * 0.03;
  // v2: the head is stabilised — it keeps most of its angle and damps part of the bob
  const headPitch = -def.walk.headDown + look.pitch - lean * (v2 ? 0.75 : 0.4) + drift * (0.4 + idleK);
  const headBobComp = v2 ? bobAmp * bobK * 0.3 : 0;
  const head = { x: neck.x + 0.02 + Math.sin(headPitch * 0.2) * 0.01, y: neck.y + P.headR * 0.95 + headBobComp };

  // arms: hidden under the cloak, swinging opposite to the legs; (v2) the shoulders
  // counter-rotate the pelvis and the forearm trails the upper arm
  const walkK = clamp(s.v / 0.7, 0, 1.2) * (mode === 'walk' ? 1 : mode === 'settle' ? 1 - s.settle : 0);
  const swingA = (v2 ? 0.3 * G.swing : 0.2) * walkK;
  const shoulderSwing = v2 ? 0.02 * G.swing * walkK * Math.cos(TAU * s.phase) : 0;
  const shoulders = { x: chest.x - 0.01 + shoulderSwing, y: chest.y - 0.05 };
  const elbows: any[] = [];
  const hands: any[] = [];
  for (let k = 0; k < 2; k++) {
    const a = (k === 0 ? -1 : 1) * swingA * Math.cos(TAU * s.phase) + 0.05;
    const el = { x: shoulders.x + Math.sin(a) * 0.29, y: shoulders.y - Math.cos(a) * 0.29 };
    const fa = a + 0.25 + (v2 ? (k === 0 ? -1 : 1) * swingA * 0.45 * Math.cos(TAU * (s.phase - 0.08)) : 0);
    hands.push({ x: el.x + Math.sin(fa) * 0.26, y: el.y - Math.cos(fa) * 0.26 });
    elbows.push(el);
  }

  // blinks: slow, occasional (seeded)
  let eyeOpen = 1;
  const blinkPeriod = 4.3;
  const bi = Math.floor(t / blinkPeriod);
  const bt = bi * blinkPeriod + hashf(seed, bi, 9) * 2.5;
  const db = t - bt;
  if (db >= 0 && db < 0.32) eyeOpen = Math.abs(db - 0.13) < 0.13 ? 1 - Math.sin((db / 0.26) * Math.PI) : 1;

  return {
    t,
    u: s.dist,
    speed: s.v,
    phase: s.phase,
    mode,
    hip,
    chest,
    neck,
    head,
    lean,
    headPitch,
    headYaw: look.yaw,
    headTilt: look.tilt,
    knees,
    feet,
    shoulders,
    elbows: elbows as any,
    hands: hands as any,
    // front view: weight transfer over the stance foot
    sway: (v2 ? 0.028 : 0.022) * Math.sin(TAU * (s.phase - (v2 ? 0.06 : 0))) * bobW + weightShift * 1.5,
    breath,
    eyeOpen: clamp(eyeOpen),
  };
}
