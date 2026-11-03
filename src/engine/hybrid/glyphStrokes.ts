import type { GlyphSet } from '../ascii/GlyphSet';
import type { RGB } from '../core/color';

/**
 * Free glyphs ("strokes"): ASCII characters placed at world-anchored positions
 * instead of grid cells — stems as `| / \`, blooms as `@ o *`, blades and petals as
 * `' , \``. Same character size as the global grid. Identity comes from the world
 * (hash of the instance), never from the frame, so they move with the scene instead
 * of flickering. Only vegetation and particles use them (grid stays for the rest).
 */
export class StrokeBuffer {
  n = 0;
  readonly cap: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly depth: Float32Array;
  readonly code: Uint16Array;
  readonly rgb: Float32Array;
  readonly alpha: Float32Array;
  private order: Uint32Array;

  constructor(cap: number) {
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.depth = new Float32Array(cap);
    this.code = new Uint16Array(cap);
    this.rgb = new Float32Array(cap * 3);
    this.alpha = new Float32Array(cap);
    this.order = new Uint32Array(cap);
  }

  reset() {
    this.n = 0;
  }

  /** Adds a stroke (virtual-px position). Returns false when full. */
  add(x: number, y: number, depth: number, ch: number, c: RGB, alpha: number) {
    if (this.n >= this.cap) return false;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.depth[i] = depth;
    this.code[i] = ch;
    this.rgb[i * 3] = c[0];
    this.rgb[i * 3 + 1] = c[1];
    this.rgb[i * 3 + 2] = c[2];
    this.alpha[i] = alpha;
    return true;
  }

  /** Indices sorted far → near (near strokes draw last). */
  sorted(): Uint32Array {
    const o = this.order;
    for (let i = 0; i < this.n; i++) o[i] = i;
    const d = this.depth;
    const view = o.subarray(0, this.n);
    view.sort((a, b) => d[b] - d[a] || a - b);
    return view;
  }
}

/** Stroke glyph for a screen-space direction (dx, dy with y down). Hysteresis-free but stable: thresholds are fixed. */
export function stemChar(dx: number, dy: number): number {
  const a = Math.atan2(dx, -dy); // 0 = straight up, + = leaning right
  if (a > 0.32) return 47; // '/'
  if (a < -0.32) return 92; // '\'
  return 124; // '|'
}

export interface StrokeDrawOptions {
  W: number;
  H: number;
  vw: number;
  vh: number;
  cols: number;
  rows: number;
  grade: (c: RGB) => RGB;
  glyphGain: number;
  /** returns true when the stroke is hidden (depth test against the scene) */
  occluded: (vx: number, vy: number, depth: number) => boolean;
}

/** Blit strokes into the final RGBA buffer using the glyph masks of the grid's cell size. */
export function drawStrokes(out: Uint8ClampedArray, S: StrokeBuffer, glyphs: GlyphSet, o: StrokeDrawOptions): number {
  const cwF = o.W / o.cols;
  const chF = o.H / o.rows;
  const cw = Math.ceil(cwF);
  const ch = Math.ceil(chF);
  const masks = glyphs.masks(cw, ch);
  const kx = o.W / o.vw;
  const ky = o.H / o.vh;
  let drawn = 0;
  for (const s of S.sorted()) {
    const vx = S.x[s];
    const vy = S.y[s];
    if (o.occluded(vx, vy, S.depth[s])) continue;
    const gi = glyphs.indexOfCode(S.code[s]);
    if (gi < 0) continue;
    const c = o.grade([S.rgb[s * 3], S.rgb[s * 3 + 1], S.rgb[s * 3 + 2]]);
    let r = c[0] * o.glyphGain;
    let g = c[1] * o.glyphGain;
    let b = c[2] * o.glyphGain;
    const m = Math.max(r, g, b);
    if (m > 1) {
      r /= m;
      g /= m;
      b /= m;
    }
    r *= 255;
    g *= 255;
    b *= 255;
    const ox = Math.round(vx * kx - cw / 2);
    const oy = Math.round(vy * ky - ch / 2);
    const idx = masks.idx[gi];
    const al = masks.alpha[gi];
    const A = S.alpha[s];
    for (let k = 0; k < idx.length; k++) {
      const p = idx[k];
      const py = (p / cw) | 0;
      const X = ox + p - py * cw;
      const Y = oy + py;
      if (X < 0 || Y < 0 || X >= o.W || Y >= o.H) continue;
      const i = (Y * o.W + X) * 4;
      const a = al[k] * A;
      out[i] += (r - out[i]) * a;
      out[i + 1] += (g - out[i + 1]) * a;
      out[i + 2] += (b - out[i + 2]) * a;
    }
    drawn++;
  }
  return drawn;
}
