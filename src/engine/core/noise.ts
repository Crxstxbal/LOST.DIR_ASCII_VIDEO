import { mulberry32 } from './rng';

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

// Fixed permutation + value tables (deterministic, built once). Lattice period 1024.
const PN = 1024;
const PM = PN - 1;
const PERM = new Uint16Array(PN * 2);
const VAL = new Float32Array(PN);
{
  const r = mulberry32(0x10575d1);
  const p = Array.from({ length: PN }, (_, i) => i);
  for (let i = PN - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < PN * 2; i++) PERM[i] = p[i & PM];
  for (let i = 0; i < PN; i++) VAL[i] = r();
}
/** Fast lattice hash → [0,1). */
export function lat2(ix: number, iy: number, seed: number): number {
  return VAL[PERM[(PERM[(ix + Math.imul(seed, 31)) & PM] + iy) & PM]];
}
function lat1(ix: number, seed: number): number {
  return VAL[PERM[(ix + Math.imul(seed, 131)) & PM]];
}

/** 1D value noise in [-1,1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = lat1(i, seed) * 2 - 1;
  const b = lat1(i + 1, seed) * 2 - 1;
  return a + (b - a) * fade(f);
}

/** 2D value noise in [-1,1]. */
export function noise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const a = lat2(ix, iy, seed);
  const b = lat2(ix + 1, iy, seed);
  const c = lat2(ix, iy + 1, seed);
  const d = lat2(ix + 1, iy + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return (ab + (cd - ab) * fy) * 2 - 1;
}

/** Fractal 2D noise in roughly [-1,1]. */
export function fbm2(x: number, y: number, octaves = 4, seed = 0, lac = 2.03, gain = 0.5): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x, y, seed + o * 131) * amp;
    norm += amp;
    x *= lac;
    y *= lac;
    amp *= gain;
  }
  return sum / norm;
}

/** Fractal 1D noise in roughly [-1,1]. */
export function fbm1(x: number, octaves = 3, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(x, seed + o * 71) * amp;
    norm += amp;
    x *= 2.1;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Cellular (Worley F2-F1) edge value: ~0 on cell borders → used for cracks. */
export function cellEdge(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i + lat2(ix + i, iy + j, seed);
      const cy = iy + j + lat2(ix + i, iy + j, seed + 1);
      const dx = cx - x;
      const dy = cy - y;
      const d = dx * dx + dy * dy;
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  return Math.sqrt(f2) - Math.sqrt(f1);
}
