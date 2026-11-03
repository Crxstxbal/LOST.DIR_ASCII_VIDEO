import { createCanvas, ctx2d } from '../core/canvasFactory';
import { CHARSETS, DEFAULT_CHARSET } from './charsets';
import { ZX, ZY } from '../raster/Painter';

export const FONT_FAMILY = 'Consolas, "Lucida Console", "Courier New", monospace';
/** Monospace advance ≈ 0.55 em for Consolas. Cell aspect w/h. */
export const CELL_ASPECT = 0.55;

/** Quantization levels per zone for the shape LUT. 5^6 = 15625 entries. */
export const QLEVELS = 5;
const NZ = ZX * ZY;

export interface GlyphMasks {
  cw: number;
  ch: number;
  /** For each glyph: flattened list of [pixelIndexInCell, alpha(0..1)] for non-zero pixels. */
  idx: Int32Array[];
  alpha: Float32Array[];
}

function renderMasks(chars: string[], cw: number, ch: number) {
  const n = chars.length;
  const canvas = createCanvas(cw * n, ch);
  const c = ctx2d(canvas);
  c.fillStyle = '#000';
  c.fillRect(0, 0, cw * n, ch);
  c.fillStyle = '#fff';
  const fontPx = Math.min(ch * 1.02, cw / CELL_ASPECT);
  c.font = `${fontPx.toFixed(2)}px ${FONT_FAMILY}`;
  c.textBaseline = 'middle';
  c.textAlign = 'center';
  for (let i = 0; i < n; i++) c.fillText(chars[i], i * cw + cw / 2, ch * 0.54);
  const data = c.getImageData(0, 0, cw * n, ch).data;
  const masks: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const m = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        m[y * cw + x] = data[(y * cw * n + i * cw + x) * 4] / 255;
      }
    }
    masks.push(m);
  }
  return masks;
}

/**
 * A charset measured against the actual font: per-glyph ink coverage in a 2×3 zone
 * grid, a precomputed shape LUT, and pixel masks at the output cell size.
 */
export class GlyphSet {
  readonly name: string;
  readonly chars: string[];
  readonly desc: Float32Array[];
  readonly mean: Float32Array;
  readonly lut: Uint8Array;
  readonly rampLut: Uint8Array;
  private maskCache = new Map<string, GlyphMasks>();

  constructor(name: string) {
    const def = CHARSETS[name] ?? CHARSETS[DEFAULT_CHARSET];
    this.name = CHARSETS[name] ? name : DEFAULT_CHARSET;
    const set = new Set<string>([' ', ...def.shape, ...def.ramp]);
    this.chars = [...set];
    const RW = 22;
    const RH = 40;
    const masks = renderMasks(this.chars, RW, RH);
    // zone coverage
    const raw: number[][] = masks.map((m) => {
      const z = new Array(NZ).fill(0);
      const cnt = new Array(NZ).fill(0);
      for (let y = 0; y < RH; y++) {
        const zy = Math.min(ZY - 1, Math.floor((y / RH) * ZY));
        for (let x = 0; x < RW; x++) {
          const zx = Math.min(ZX - 1, Math.floor((x / RW) * ZX));
          z[zy * ZX + zx] += m[y * RW + x];
          cnt[zy * ZX + zx]++;
        }
      }
      return z.map((v, i) => v / cnt[i]);
    });
    let maxZ = 1e-6;
    for (const z of raw) for (const v of z) maxZ = Math.max(maxZ, v);
    // Normalise so the densest zone of the densest glyph = 1; apply a gentle gamma so
    // mid densities spread across more glyphs.
    this.desc = raw.map((z) => Float32Array.from(z.map((v) => Math.pow(v / maxZ, 0.8))));
    this.mean = Float32Array.from(this.desc.map((d) => d.reduce((a, b) => a + b, 0) / NZ));

    const rampIdx = [...new Set([' ', ...def.ramp])].map((ch) => this.chars.indexOf(ch)).filter((i) => i >= 0);
    rampIdx.sort((a, b) => this.mean[a] - this.mean[b]);
    // continuous ramp: density 0..1 → nearest glyph by mean ink, rescaled to the ramp's range
    this.rampLut = new Uint8Array(256);
    const rMax = this.mean[rampIdx[rampIdx.length - 1]];
    for (let k = 0; k < 256; k++) {
      const target = (k / 255) * rMax;
      let best = rampIdx[0];
      let bs = Infinity;
      for (const i of rampIdx) {
        const s = Math.abs(this.mean[i] - target);
        if (s < bs) {
          bs = s;
          best = i;
        }
      }
      this.rampLut[k] = best;
    }

    // Build LUT.
    const size = Math.pow(QLEVELS, NZ);
    this.lut = new Uint8Array(size);
    const target = new Float32Array(NZ);
    for (let key = 0; key < size; key++) {
      let k = key;
      let m = 0;
      for (let z = 0; z < NZ; z++) {
        target[z] = (k % QLEVELS) / (QLEVELS - 1);
        k = Math.floor(k / QLEVELS);
        m += target[z];
      }
      m /= NZ;
      let mn = 1;
      let mx = 0;
      for (let z = 0; z < NZ; z++) {
        mn = Math.min(mn, target[z]);
        mx = Math.max(mx, target[z]);
      }
      let best = 0;
      let bestS = Infinity;
      // one quantisation step of difference is noise, not structure → density ramp
      if (mx - mn <= 1 / (QLEVELS - 1) + 1e-6) {
        // flat area → density ramp
        for (const i of rampIdx) {
          const s = Math.abs(this.mean[i] - m);
          if (s < bestS) {
            bestS = s;
            best = i;
          }
        }
      } else {
        for (let i = 0; i < this.chars.length; i++) {
          const d = this.desc[i];
          let s = 0;
          for (let z = 0; z < NZ; z++) {
            const e = target[z] - d[z];
            s += e * e;
          }
          const dm = m - this.mean[i];
          s += dm * dm * 2.5;
          if (s < bestS) {
            bestS = s;
            best = i;
          }
        }
      }
      this.lut[key] = best;
    }
  }

  private codeIndex: Map<number, number> | null = null;
  /** Glyph index for a char code, or -1 if the charset doesn't contain it. */
  indexOfCode(code: number): number {
    if (!this.codeIndex) {
      this.codeIndex = new Map();
      this.chars.forEach((ch, i) => this.codeIndex!.set(ch.charCodeAt(0), i));
    }
    return this.codeIndex.get(code) ?? -1;
  }

  /** Index of the best glyph for 6 zone densities (0..1) with an optional dither offset. */
  pick(z: ArrayLike<number>, dither = 0): number {
    let mn = 1;
    let mx = 0;
    let m = 0;
    for (let i = 0; i < NZ; i++) {
      const v = z[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      m += v;
    }
    m /= NZ;
    if (mx - mn < 0.24) {
      // flat cell: continuous density ramp (many more levels than the shape LUT)
      let k = Math.round((m + dither * 0.09) * 255);
      k = k < 0 ? 0 : k > 255 ? 255 : k;
      return this.rampLut[k];
    }
    let key = 0;
    let mul = 1;
    for (let i = 0; i < NZ; i++) {
      let q = Math.round(z[i] * (QLEVELS - 1) + dither);
      q = q < 0 ? 0 : q > QLEVELS - 1 ? QLEVELS - 1 : q;
      key += q * mul;
      mul *= QLEVELS;
    }
    return this.lut[key];
  }

  masks(cw: number, ch: number): GlyphMasks {
    const key = `${cw}x${ch}`;
    let m = this.maskCache.get(key);
    if (m) return m;
    const raw = renderMasks(this.chars, cw, ch);
    const idx: Int32Array[] = [];
    const alpha: Float32Array[] = [];
    for (const g of raw) {
      const ii: number[] = [];
      const aa: number[] = [];
      for (let p = 0; p < g.length; p++) {
        if (g[p] > 0.02) {
          ii.push(p);
          aa.push(g[p]);
        }
      }
      idx.push(Int32Array.from(ii));
      alpha.push(Float32Array.from(aa));
    }
    m = { cw, ch, idx, alpha };
    this.maskCache.set(key, m);
    return m;
  }
}

const sets = new Map<string, GlyphSet>();
export function getGlyphSet(name: string): GlyphSet {
  let s = sets.get(name);
  if (!s) {
    s = new GlyphSet(name);
    sets.set(name, s);
  }
  return s;
}
