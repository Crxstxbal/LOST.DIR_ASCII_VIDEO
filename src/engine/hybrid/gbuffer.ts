/**
 * Intermediate image of the HYBRID renderer, at shape-zone resolution (cols·2 ×
 * rows·3): exactly the detail the ASCII conversion can use, which keeps a pure
 * software rasteriser affordable. Reused between frames (no per-frame allocation).
 */
export const KIND_SKY = 0;
export const KIND_TERRAIN = 1;
export const KIND_VEG = 2;
export const KIND_FAR = 3;

export class GBuffer {
  readonly w: number;
  readonly h: number;
  /** albedo (linear-ish 0..1) */
  readonly albedo: Float32Array;
  /** world-space normal */
  readonly normal: Float32Array;
  /** camera-space depth (Infinity = sky) */
  readonly depth: Float32Array;
  readonly kind: Uint8Array;
  /** extra ink multiplier per pixel (vegetation mass is drawn mostly by free glyphs) */
  readonly ink: Float32Array;
  /** lit colour + ink density, filled by the lighting pass */
  readonly lit: Float32Array;
  readonly dens: Float32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.albedo = new Float32Array(n * 3);
    this.normal = new Float32Array(n * 3);
    this.depth = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.ink = new Float32Array(n);
    this.lit = new Float32Array(n * 3);
    this.dens = new Float32Array(n);
  }

  clear() {
    this.depth.fill(Infinity);
    this.kind.fill(KIND_SKY);
    this.ink.fill(1);
  }
}

const pool = new Map<string, GBuffer>();
export function gbufferFor(w: number, h: number) {
  const k = `${w}x${h}`;
  let g = pool.get(k);
  if (!g) {
    g = new GBuffer(w, h);
    pool.set(k, g);
    if (pool.size > 4) pool.delete(pool.keys().next().value!);
  }
  g.clear();
  return g;
}
