import { mix, type RGB } from '../core/color';
import { clamp, lerp, smoothstep } from '../core/math';
import { orient, type HeadOrient, type V3 } from './head';

/**
 * Face v2: the face is an implicit 3D surface in head-local space (metres,
 * x = character's left→right seen from the front, y up, z out of the face),
 * ray-cast per shape zone and lit per pixel. Eyes, mouth and brows are albedo
 * changes on that surface, so anatomy comes from light and shadow rather than
 * from black outlines. Primary reference: the black-and-white charcoal
 * illustration (References/01_CHARACTER/8f74c….jpg) — narrow pale face, thin
 * sunken eye slits, lit nose bridge, small dark mouth, half the face in shadow.
 */
export interface FaceParams {
  /** 'v2' = this face; 'v1' = the original prototype face (kept for comparison). */
  style: 'v1' | 'v2';
  /** Face width multiplier. */
  width: number;
  /** Jaw narrowness: < 1 = more delicate, pointed chin. */
  jaw: number;
  /** Eyelid openness (0 = closed, 1 = fully open). Tired by default. */
  eyeOpen: number;
  /** Eye slit length. */
  eyeSize: number;
  /** Depth / darkness of the eye sockets. */
  eyeDepth: number;
  /** Mouth width. */
  mouthWidth: number;
  /** Darkness of the unlit half of the face (0 = flat, 1 = black). */
  shadow: number;
  /** Softness of the light/shadow terminator. */
  softness: number;
  /** Bang length. */
  bangs: number;
  /** Hair volume around the face. */
  hairVolume: number;
  /** Height of the cloak's collar around the neck. */
  collar: number;
}

export const DEFAULT_FACE: FaceParams = {
  style: 'v2',
  width: 1,
  jaw: 1,
  eyeOpen: 0.55,
  eyeSize: 1,
  eyeDepth: 1,
  mouthWidth: 1,
  shadow: 0.82,
  softness: 0.35,
  bangs: 1,
  hairVolume: 1.1,
  collar: 1,
};

export type FaceNumKey = Exclude<keyof FaceParams, 'style'>;

/** Ranges for the editor sliders. */
export const FACE_PARAM_DEFS: { key: FaceNumKey; label: string; min: number; max: number; step: number }[] = [
  { key: 'width', label: 'Ancho del rostro', min: 0.8, max: 1.2, step: 0.01 },
  { key: 'jaw', label: 'Mandíbula', min: 0.75, max: 1.2, step: 0.01 },
  { key: 'eyeOpen', label: 'Apertura de párpados', min: 0.15, max: 1, step: 0.01 },
  { key: 'eyeSize', label: 'Tamaño de ojos', min: 0.7, max: 1.3, step: 0.01 },
  { key: 'eyeDepth', label: 'Profundidad de cuencas', min: 0, max: 1.6, step: 0.01 },
  { key: 'mouthWidth', label: 'Ancho de boca', min: 0.7, max: 1.3, step: 0.01 },
  { key: 'shadow', label: 'Penumbra', min: 0, max: 1, step: 0.01 },
  { key: 'softness', label: 'Suavidad de la luz', min: 0, max: 1, step: 0.01 },
  { key: 'bangs', label: 'Largo del flequillo', min: 0.4, max: 1.5, step: 0.01 },
  { key: 'hairVolume', label: 'Volumen del cabello', min: 0.8, max: 1.4, step: 0.01 },
  { key: 'collar', label: 'Altura del cuello de la capa', min: 0, max: 1.5, step: 0.01 },
];

export function resolveFace(p?: Partial<FaceParams>): FaceParams {
  return { ...DEFAULT_FACE, ...(p ?? {}) };
}

/** Inverse of `orient` (view space → head-local). */
export function invOrient(p: V3, o: HeadOrient): V3 {
  let [x, y, z] = p;
  const ct = Math.cos(o.tilt);
  const st = Math.sin(o.tilt);
  const x1 = x * ct + y * st;
  y = -x * st + y * ct;
  x = x1;
  const cy = Math.cos(o.yaw);
  const sy = Math.sin(o.yaw);
  const x2 = x * cy - z * sy;
  z = x * sy + z * cy;
  x = x2;
  const cp = Math.cos(o.pitch);
  const sp = Math.sin(o.pitch);
  return [x, y * cp - z * sp, y * sp + z * cp];
}

// ---- face volume: cross-section tables sampled every 2 cm from y=+0.12 to y=-0.12 ----
const Y0 = 0.12;
const DY = 0.02;
/** Half width of the face at each height (narrow, long, delicate jaw). */
const T_W = [0.03, 0.046, 0.054, 0.058, 0.06, 0.061, 0.0615, 0.061, 0.0575, 0.0505, 0.0405, 0.027, 0.01];
/** Front surface depth along the midline (before features). */
const T_ZF = [0.045, 0.068, 0.08, 0.087, 0.09, 0.09, 0.084, 0.085, 0.088, 0.087, 0.082, 0.072, 0.04];
/** Back of the head/jaw. */
const T_ZB = [-0.02, -0.06, -0.085, -0.095, -0.098, -0.098, -0.095, -0.08, -0.058, -0.036, -0.012, 0.012, 0.024];
const Y_TOP = 0.125;
const Y_BOT = -0.124;

/** Catmull-Rom sample of a uniform table at height y. */
function table(T: number[], y: number): number {
  const f = (Y0 - y) / DY;
  const n = T.length;
  const i = Math.max(0, Math.min(n - 2, Math.floor(f)));
  const t = clamp(f - i, 0, 1);
  const p0 = T[Math.max(0, i - 1)];
  const p1 = T[i];
  const p2 = T[i + 1];
  const p3 = T[Math.min(n - 1, i + 2)];
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Gaussian bump; skipped (exactly 0) beyond ~3.5σ where it is below 5e-6 of its peak. */
const g2 = (a: number, b: number) => {
  const q = a * a + b * b;
  return q > 12 ? 0 : Math.exp(-q);
};

// Performance: the cross-section tables are sampled through precomputed lookup
// tables (linear interpolation of a 1024-step Catmull-Rom resampling) instead of
// evaluating the spline at every ray-march step.
const LUT_N = 1024;
const LUT_Y0 = Y_TOP + 0.012;
const LUT_Y1 = Y_BOT - 0.012;
const LUT_K = (LUT_N - 1) / (LUT_Y0 - LUT_Y1);
function bake(T: number[]) {
  const a = new Float32Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) a[i] = table(T, LUT_Y0 - i / LUT_K);
  return a;
}
let LW: Float32Array | null = null;
let LZF: Float32Array | null = null;
let LZB: Float32Array | null = null;
let LJAW: Float32Array | null = null;
function luts() {
  if (!LW) {
    LW = bake(T_W);
    LZF = bake(T_ZF);
    LZB = bake(T_ZB);
    LJAW = new Float32Array(LUT_N);
    for (let i = 0; i < LUT_N; i++) LJAW[i] = smoothstep(-0.02, -0.1, LUT_Y0 - i / LUT_K);
  }
}
function lut(a: Float32Array, y: number): number {
  let f = (LUT_Y0 - y) * LUT_K;
  if (f < 0) f = 0;
  else if (f > LUT_N - 1.001) f = LUT_N - 1.001;
  const i = f | 0;
  const t = f - i;
  return a[i] + (a[i + 1] - a[i]) * t;
}

/** Width multiplier for a height: `width` everywhere, `jaw` progressively below the cheekbones. */
function widthAt(F: FaceParams, y: number) {
  luts();
  const jawK = 1 + (F.jaw - 1) * lut(LJAW!, y);
  return lut(LW!, y) * F.width * jawK;
}

/** Facial relief added to the front surface (m along local z). Returns relief and cavity (for occlusion). */
let reliefK = 1;

function relief(F: FaceParams, x: number, y: number, out: { cav: number }) {
  const ax = Math.abs(x);
  let d = 0;
  // nose: thin bridge growing to a small defined tip
  let h: number;
  if (y > -0.03) h = 0.003 * smoothstep(0.034, 0.014, y) + 0.021 * smoothstep(0.012, -0.03, y);
  else h = 0.024 * (1 - smoothstep(-0.03, -0.045, y));
  const nw = lerp(0.0055, 0.011, smoothstep(0.012, -0.036, y));
  if (h > 0 && x * x < 12 * nw * nw) d += h * Math.exp(-(x * x) / (nw * nw));
  // alar wings
  d += 0.006 * g2((ax - 0.0105) / 0.006, (y + 0.04) / 0.006);
  // eye sockets (sunken)
  const sock = 0.012 * F.eyeDepth * g2((ax - 0.027) / 0.017, (y + 0.002) / 0.012);
  d -= sock;
  // brow ridge
  d += 0.004 * g2((ax - 0.026) / 0.02, (y - 0.017) / 0.007);
  // cheekbones and the hollow under them
  d += 0.0055 * g2((ax - 0.043) / 0.014, (y + 0.024) / 0.013);
  const hollow = 0.005 * g2((ax - 0.043) / 0.013, (y + 0.056) / 0.015);
  d -= hollow;
  // lips + the groove under the lower lip, chin
  const mw = F.mouthWidth;
  d += 0.004 * g2(x / (0.015 * mw), (y + 0.058) / 0.005);
  d += 0.005 * g2(x / (0.013 * mw), (y + 0.07) / 0.005);
  d -= 0.0025 * g2(x / 0.014, (y + 0.08) / 0.005);
  d += 0.004 * g2(x / 0.015, (y + 0.1) / 0.01);
  out.cav = (sock / 0.012 + hollow / 0.01) * reliefK;
  return d * reliefK;
}

const tmpCav = { cav: 0 };

/** Implicit face volume: < 0 inside. */
function field(F: FaceParams, x: number, y: number, z: number): number {
  if (y > Y_TOP || y < Y_BOT) return 1;
  const W = widthAt(F, y);
  const zf = lut(LZF!, y);
  const zb = lut(LZB!, y);
  const D = (zf - zb) / 2;
  const zc = (zf + zb) / 2;
  const zz = z - zc - relief(F, x, y, tmpCav);
  return (x / W) * (x / W) + (zz / D) * (zz / D) - 1;
}

/** Cheap inflated bound (no relief) used to skip empty space before the fine march. */
function bound(F: FaceParams, x: number, y: number, z: number): number {
  if (y > Y_TOP + 0.01 || y < Y_BOT - 0.01) return 1;
  const yc = clamp(y, Y_BOT, Y_TOP);
  const W = widthAt(F, yc) + 0.01;
  const zf = lut(LZF!, yc) + 0.03;
  const zb = lut(LZB!, yc) - 0.01;
  const D = (zf - zb) / 2;
  const zc = (zf + zb) / 2;
  return (x / W) * (x / W) + ((z - zc) / D) * ((z - zc) / D) - 1;
}

/** Point on the front surface of the face (head-local) for placing hair/bangs on it. */
export function faceFrontZ(F: FaceParams, x: number, y: number): number {
  const yc = clamp(y, Y_BOT, Y_TOP);
  const W = widthAt(F, yc);
  const zf = lut(LZF!, yc);
  const zb = lut(LZB!, yc);
  const D = (zf - zb) / 2;
  const zc = (zf + zb) / 2;
  const u = clamp(Math.abs(x) / W, 0, 0.999);
  return zc + D * Math.sqrt(1 - u * u) + relief(F, x, yc, tmpCav);
}

export interface FaceShadeInput {
  /** Screen centre of the head (virtual px) and px per metre. */
  cx: number;
  cy: number;
  s: number;
  vk: number;
  o: HeadOrient;
  /** Screen side of the key light: -1 left, +1 right. */
  lightSide: number;
  rim: number;
  rimColor: RGB;
  eyeOpen: number;
  colors: { skin: RGB; skinShadow: RGB; eyes: RGB; lips: RGB; hair: RGB };
  alpha: number;
  /** LOD weights: relief (anatomy), features (eyes/mouth/brows), ecu (extreme close-up extras). */
  lod?: { relief: number; features: number; ecu: number };
}

export interface ShadeTarget {
  readonly k: number;
  readonly h: number;
  readonly vh: number;
  shade(vy0: number, vy1: number, fn: (vx: number, vy: number, out: Float32Array) => boolean, vx0?: number, vx1?: number): void;
}

/** Ray-cast and light the face onto a painter. */
export function shadeFace(P: ShadeTarget, F: FaceParams, I: FaceShadeInput) {
  const { cx, cy, s, vk, o } = I;
  // screen bounds: project the volume's bounding box
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const bx of [-0.075, 0.075])
    for (const by of [Y_TOP, Y_BOT])
      for (const bz of [-0.1, 0.13]) {
        const q = orient([bx, by, bz], o);
        const sx = cx + q[0] * s;
        const sy = cy - q[1] * s * vk;
        x0 = Math.min(x0, sx);
        x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy);
        y1 = Math.max(y1, sy);
      }
  // ray direction in local space (toward the camera = view +z)
  const dir = invOrient([0, 0, 1], o);
  const nL = (() => {
    const v: V3 = [I.lightSide * 0.72, 0.5, 0.48];
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  })();
  const ambient = lerp(0.36, 0.05, F.shadow);
  const t0 = -0.04 - F.softness * 0.22;
  const t1 = 0.1 + F.softness * 0.32;
  const C = I.colors;
  const deep = mix(C.skinShadow, [0, 0, 0], 0.62);
  const eyeC = mix(C.eyes, C.skinShadow, 0.12);
  const lipC = mix(C.lips, [0, 0, 0], 0.25);
  const open = clamp(F.eyeOpen * I.eyeOpen, 0, 1);
  const es = F.eyeSize;
  const mwid = 0.0145 * F.mouthWidth;
  const cav = { cav: 0 };
  const fw = I.lod?.features ?? 1;
  const ecu = I.lod?.ecu ?? 0;
  reliefK = I.lod?.relief ?? 1;

  // Paths are drawn with a uniform virtual→raster scale while shaded bands map
  // y through the cell grid, so paths land `ry` times lower on screen. Shade in
  // path space so the face stays glued to the hair and body drawn as paths.
  const ry = (P.k * P.vh) / P.h;
  // bounding ellipsoid of the inflated face volume (head-local), and the ray direction in its units
  const EX = 0.0615 * F.width * Math.max(1, F.jaw) + 0.016;
  const EY = Y_TOP + 0.014;
  const EZC = 0.006;
  const EZ = 0.135;
  const edx = dir[0] / EX;
  const edy = dir[1] / EY;
  const edz = dir[2] / EZ;
  P.shade(
    y0 * ry,
    y1 * ry,
    (vx, vyScreen, out) => {
      if (vx < x0 || vx > x1) return false;
      const vy = vyScreen / ry;
      const X = (vx - cx) / s;
      const Y = -(vy - cy) / (s * vk);
      const p0 = invOrient([X, Y, 0], o);
      // march from the camera side toward the back
      const at = (t: number): V3 => [p0[0] + dir[0] * t, p0[1] + dir[1] * t, p0[2] + dir[2] * t];
      // analytic ray / bounding-ellipsoid test: most pixels of the head's box miss the
      // face entirely, and for the rest it bounds the march to the inside segment
      const qx = p0[0] / EX;
      const qy = p0[1] / EY;
      const qz = (p0[2] - EZC) / EZ;
      const qa = edx * edx + edy * edy + edz * edz;
      const qb = 2 * (qx * edx + qy * edy + qz * edz);
      const qc = qx * qx + qy * qy + qz * qz - 1;
      const disc = qb * qb - 4 * qa * qc;
      if (disc <= 0) return false;
      const sq = Math.sqrt(disc);
      let t = Math.min(0.16, (-qb + sq) / (2 * qa));
      const tEnd = Math.max(-0.12, (-qb - sq) / (2 * qa));
      if (t <= tEnd) return false;
      // coarse: skip to the inflated bound
      let inB = false;
      for (; t > tEnd; t -= 0.008) {
        const p = at(t);
        if (bound(F, p[0], p[1], p[2]) < 0) {
          inB = true;
          break;
        }
      }
      if (!inB) return false;
      t += 0.008;
      let prevT = t;
      let hit = false;
      for (; t > tEnd; t -= 0.0035) {
        const p = at(t);
        if (field(F, p[0], p[1], p[2]) < 0) {
          hit = true;
          break;
        }
        prevT = t;
      }
      if (!hit) return false;
      // refine
      let a = prevT;
      let b = t;
      for (let k = 0; k < 6; k++) {
        const m = (a + b) / 2;
        const p = at(m);
        if (field(F, p[0], p[1], p[2]) < 0) b = m;
        else a = m;
      }
      const [x, y, z] = at((a + b) / 2);
      // behind the hairline (temples, sides of the skull) the hair mass shows instead
      if (z < lerp(-0.02, 0.035, smoothstep(-0.03, 0.04, y))) return false;
      // normal from the field gradient (local) → view
      const e = 0.0015;
      const f0 = field(F, x, y, z);
      const gx = field(F, x + e, y, z) - f0;
      const gy = field(F, x, y + e, z) - f0;
      const gz = field(F, x, y, z + e) - f0;
      const gl = Math.hypot(gx, gy, gz) || 1;
      const n = orient([gx / gl, gy / gl, gz / gl], o);
      relief(F, x, y, cav);

      // ---- lighting ----
      const ndl = n[0] * nL[0] + n[1] * nL[1] + n[2] * nL[2];
      const key = smoothstep(t0, t1, ndl);
      const W = widthAt(F, y);
      const ex = (x / W) * (x / W);
      let ao = 1 - 0.68 * clamp(cav.cav);
      ao *= 1 - 0.5 * smoothstep(0.5, 1, ex); // hair shadow at the temples/cheeks
      ao *= 1 - 0.45 * smoothstep(0.035, 0.085, y); // bangs shade the forehead
      ao *= 1 - 0.35 * smoothstep(-0.085, -0.115, y); // under the jaw
      // shadow under the nose tip
      ao *= 1 - 0.45 * g2(x / 0.012, (y + 0.05) / 0.005);
      let lum = ao * (ambient + (1 - ambient) * key);
      const lum0 = lum;

      // ---- albedo features ----
      let col: RGB | null = null;
      let dens = -1;
      const ax = Math.abs(x);
      // eyes: narrow almond slits with heavy upper lids
      const u = (ax - 0.027) / (0.0125 * es);
      if (Math.abs(u) < 1.25) {
        const yy = y + 0.001 + u * 0.0012; // outer corners droop slightly
        const w = Math.max(0, 1 - u * u);
        const top = 0.0052 * es * Math.pow(w, 0.75) * (0.25 + 0.75 * open);
        const bot = -0.0019 * es * w;
        if (Math.abs(u) < 1 && yy < top && yy > bot) {
          col = eyeC;
          lum = 0.03;
          dens = 0.14;
        } else {
          // lash line + lid crease (tired, heavy-lidded)
          const above = yy - top;
          if (above > 0 && above < 0.0032 * es && Math.abs(u) < 1.12) lum *= 0.3 - 0.12 * ecu;
          const crease = 0.0074 * es * Math.pow(Math.max(0, 1 - u * u * 0.8), 0.5);
          lum *= 1 - 0.35 * g2(u * 0.9, (yy - crease) / 0.0014);
          // tired shadow under the eye
          if (yy < bot) lum *= (1 - 0.32 * g2(u * 0.8, (yy + 0.0075) / 0.005)) * (1 - 0.28 * ecu * g2(u, (yy - bot + 0.0009) / 0.0007));
        }
      }
      // eyebrows: thin, mostly hidden by the bangs
      const by = 0.0165 + (ax - 0.012) * 0.06;
      if (ax > 0.01 && ax < 0.047) lum *= 1 - 0.38 * g2(0, (y - by) / 0.0022) * smoothstep(0.01, 0.018, ax);
      // nostrils
      lum *= 1 - 0.55 * g2((ax - 0.0055) / 0.0028, (y + 0.0445) / 0.0022);
      // mouth: small, dark, expressionless (corners slightly down)
      const mu = x / mwid;
      if (Math.abs(mu) < 1.2) {
        const ym = -0.0635 - 0.0016 * mu * mu;
        const lip = (x / (mwid * 1.15)) ** 2 + ((y + 0.065) / 0.0085) ** 2;
        if (lip < 1) col = mix(col ?? skinCol(lum, deep, C), lipC, 0.5 * (1 - lip));
        const th = 0.0012 * (1 - 0.6 * mu * mu) + 0.0003;
        if (Math.abs(mu) < 1 && Math.abs(y - ym) < th) {
          lum *= 0.22;
          col = mix(lipC, [0, 0, 0], 0.6);
        }
      }
      // lower-lip catch light (extreme close-up only)
      if (ecu > 0) lum *= 1 + 0.18 * ecu * g2(x / 0.008, (y + 0.0685) / 0.0016);
      // LOD: facial features fade out when they can no longer be drawn with the grid
      if (fw < 1) {
        lum = lum0 + (lum - lum0) * fw;
        if (col) col = mix(skinCol(lum0, deep, C), col, fw);
        if (dens >= 0) dens = lerp(0.05 + 0.74 * Math.pow(clamp(lum0 * 1.08), 0.85), dens, fw);
      }
      if (!col) col = skinCol(lum, deep, C);
      else if (dens < 0) col = mix(col, [0, 0, 0], clamp(1 - lum * 1.4) * 0.6);
      // red rim from behind on the unlit edge
      const rimK = I.rim * Math.pow(clamp(1 - Math.max(0, n[2])), 3) * (1 - key) * 0.7;
      out[0] = col[0] + (I.rimColor[0] - col[0]) * rimK;
      out[1] = col[1] + (I.rimColor[1] - col[1]) * rimK;
      out[2] = col[2] + (I.rimColor[2] - col[2]) * rimK;
      out[3] = I.alpha;
      out[4] = dens >= 0 ? dens : 0.05 + 0.74 * Math.pow(clamp(lum * 1.08 + rimK * 0.5), 0.85);
      return true;
    },
    x0,
    x1,
  );
}

function skinCol(lum: number, deep: RGB, C: FaceShadeInput['colors']): RGB {
  if (lum < 0.35) return mix(deep, C.skinShadow, lum / 0.35);
  return mix(C.skinShadow, C.skin, clamp((lum - 0.35) / 0.5));
}
