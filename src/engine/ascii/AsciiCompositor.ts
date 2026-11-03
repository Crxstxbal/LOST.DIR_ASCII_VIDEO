import type { RGB } from '../core/color';
import { hashf } from '../core/rng';
import type { Grader } from '../grading/ColorGrade';
import { Painter, SX, SY, ZX, ZY } from '../raster/Painter';
import type { GlyphSet } from './GlyphSet';

export interface Light {
  /** Virtual screen coords. */
  x: number;
  y: number;
  radius: number;
  color: RGB;
  intensity: number;
}

export interface PassInput {
  painter: Painter;
  glyphs: GlyphSet;
  /** 0 = additive over what is behind, 1 = fully hides cells it covers (foreground occluders). */
  occlude: number;
  /** Multiplier on glyph density for this pass. */
  densityGain: number;
  /** Brightness multiplier for the pass colour (used for out-of-focus layers). */
  colorGain: number;
}

export interface ComposeOptions {
  width: number;
  height: number;
  vw: number;
  vh: number;
  bg: RGB;
  bgGlow: number;
  dither: boolean;
  grade: Grader;
  lights: Light[];
  /** Colour gain applied to glyph ink (a glyph covers ~30-50% of its cell). */
  glyphGain: number;
  /** Contrast of glyph density around 0.4 (1 = unchanged). Only inked cells. */
  contrast?: number;
  /** Local contrast inside a cell (0 = unchanged): favours edge/shape glyphs. */
  sharpness?: number;
  /** Optional profiler (ms per sub-stage). */
  profile?: Record<string, number>;
}

/** Raster samples per shape zone, and the zone of each sample row/column inside a cell. */
const KX = SX / ZX;
const KY = SY / ZY;
const ZROW = Array.from({ length: SY }, (_, sy) => Math.floor(sy / KY) * ZX);
const ZCOL = Array.from({ length: SX }, (_, sx) => Math.floor(sx / KX));

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Turns pass rasters into ASCII cells and draws glyph pixels directly into an RGBA
 * buffer. No fillText at frame time → fast and bit-identical between runs.
 */
export function composeAscii(out: Uint8ClampedArray, passes: PassInput[], o: ComposeOptions) {
  const W = o.width;
  const H = o.height;
  const bg = o.grade(o.bg);
  const bgR = bg[0] * 255;
  const bgG = bg[1] * 255;
  const bgB = bg[2] * 255;
  const out32 = new Uint32Array(out.buffer, out.byteOffset, W * H);
  const pack = (r: number, g: number, b: number) =>
    ((255 << 24) | (Math.max(0, Math.min(255, Math.round(b))) << 16) | (Math.max(0, Math.min(255, Math.round(g))) << 8) | Math.max(0, Math.min(255, Math.round(r)))) >>> 0;
  out32.fill(pack(bgR, bgG, bgB));
  const z = new Float32Array(ZX * ZY);
  const contrast = o.contrast ?? 1;
  const sharp = o.sharpness ?? 0;
  const NZ = ZX * ZY;
  for (let pi = 0; pi < passes.length; pi++) {
    const pass = passes[pi];
    // the first pass draws over pristine background → constant-colour cell fills
    const clean = pi === 0;
    const P = pass.painter;
    const cols = P.cols;
    const rows = P.rows;
    const tr0 = o.profile ? performance.now() : 0;
    const cd = P.cc.getImageData(0, 0, P.w, P.h).data;
    const dd = P.dc.getImageData(0, 0, P.w, P.h).data;
    if (o.profile) o.profile['ascii: lectura de rasters'] = (o.profile['ascii: lectura de rasters'] ?? 0) + performance.now() - tr0;
    if (o.profile) o.profile['ascii: lectura pase ' + pi + (P.soft ? ' (soft)' : '') + ' ' + P.w + 'x' + P.h] = (o.profile['ascii: lectura pase ' + pi + (P.soft ? ' (soft)' : '') + ' ' + P.w + 'x' + P.h] ?? 0) + performance.now() - tr0;
    const cwF = W / cols;
    const chF = H / rows;
    const cw = Math.ceil(cwF);
    const ch = Math.ceil(chF);
    const masks = pass.glyphs.masks(cw, ch);
    const vcw = o.vw / cols;
    const vch = o.vh / rows;
    for (let r = 0; r < rows; r++) {
      const y0 = Math.floor(r * chF);
      const y1 = Math.min(H, Math.floor((r + 1) * chF));
      for (let c = 0; c < cols; c++) {
        const x0 = Math.floor(c * cwF);
        const x1 = Math.min(W, Math.floor((c + 1) * cwF));
        let asum = 0;
        let cr = 0;
        let cg = 0;
        let cb = 0;
        z.fill(0);
        for (let sy = 0; sy < SY; sy++) {
          let i = ((r * SY + sy) * P.w + c * SX) * 4;
          const zrow = ZROW[sy];
          for (let sx = 0; sx < SX; sx++, i += 4) {
            const a = cd[i + 3];
            if (a === 0) continue;
            asum += a;
            cr += cd[i] * a;
            cg += cd[i + 1] * a;
            cb += cd[i + 2] * a;
            z[zrow + ZCOL[sx]] += dd[i] * dd[i + 3];
          }
        }
        if (asum < 0.015 * 255 * SX * SY) continue;
        const cellA = asum / (255 * SX * SY);
        let col: RGB = [cr / asum / 255, cg / asum / 255, cb / asum / 255];
        col = o.grade(col);
        let r0 = col[0] * pass.colorGain;
        let g0 = col[1] * pass.colorGain;
        let b0 = col[2] * pass.colorGain;
        let zMean = 0;
        let lightAdd = 0;
        if (o.lights.length) {
          const vx = (c + 0.5) * vcw;
          const vy = (r + 0.5) * vch;
          for (const L of o.lights) {
            const d = Math.hypot(vx - L.x, vy - L.y) / L.radius;
            if (d >= 1) continue;
            const f = (1 - d) * (1 - d) * L.intensity;
            r0 += L.color[0] * f;
            g0 += L.color[1] * f;
            b0 += L.color[2] * f;
            lightAdd += f;
          }
        }
        const zn = 1 / (KX * KY * 255 * 255);
        for (let k = 0; k < NZ; k++) {
          let v = z[k] * zn * pass.densityGain;
          if (v > 0) v += lightAdd * 0.2;
          z[k] = v > 1 ? 1 : v;
          zMean += z[k];
        }
        zMean /= NZ;
        if (zMean > 0 && (sharp !== 0 || contrast !== 1)) {
          let m2 = 0;
          for (let k = 0; k < NZ; k++) {
            let v = zMean + (z[k] - zMean) * (1 + sharp);
            v = (v - 0.4) * contrast + 0.4;
            v = v < 0 ? 0 : v > 1 ? 1 : v;
            z[k] = v;
            m2 += v;
          }
          zMean = m2 / NZ;
        }
        // static per-cell hash dither (Bayer creates visible repeating letter pairs)
        const dith = o.dither ? (((BAYER4[(r & 3) * 4 + (c & 3)] / 16) * 0.35 + hashf(c, r, 7) * 0.65) - 0.5) * 0.7 : 0;
        let gi = pass.glyphs.pick(z, dith);
        const hc = P.hints[r * cols + c];
        if (hc && cellA > 0.35) {
          const hi = pass.glyphs.indexOfCode(hc);
          if (hi >= 0) gi = hi;
        }
        // glyphs only ink part of a cell: lift their colour so the frame keeps its exposure
        r0 *= o.glyphGain;
        g0 *= o.glyphGain;
        b0 *= o.glyphGain;
        const mxc = Math.max(r0, g0, b0);
        if (mxc > 1) {
          r0 /= mxc;
          g0 /= mxc;
          b0 /= mxc;
        }
        r0 *= 255;
        g0 *= 255;
        b0 *= 255;

        // cell background: occlusion + soft glow (gives depth instead of flat black)
        const fillA = cellA * pass.occlude;
        const glow = o.bgGlow * cellA * (0.35 + zMean);
        if (fillA > 0.004 || glow > 0.004) {
          const fr = bgR + (r0 - bgR) * 0.1;
          const fg = bgG + (g0 - bgG) * 0.1;
          const fb = bgB + (b0 - bgB) * 0.1;
          if (clean) {
            const col = pack(bgR + (fr - bgR) * fillA + r0 * glow, bgG + (fg - bgG) * fillA + g0 * glow, bgB + (fb - bgB) * fillA + b0 * glow);
            for (let y = y0; y < y1; y++) out32.fill(col, y * W + x0, y * W + x1);
          } else for (let y = y0; y < y1; y++) {
            let i = (y * W + x0) * 4;
            for (let x = x0; x < x1; x++, i += 4) {
              out[i] += (fr - out[i]) * fillA + r0 * glow;
              out[i + 1] += (fg - out[i + 1]) * fillA + g0 * glow;
              out[i + 2] += (fb - out[i + 2]) * fillA + b0 * glow;
            }
          }
        }
        const idx = masks.idx[gi];
        const al = masks.alpha[gi];
        const ga = Math.min(1, cellA * 1.35);
        for (let k = 0; k < idx.length; k++) {
          const p = idx[k];
          const py = (p / cw) | 0;
          const px = p - py * cw;
          const X = x0 + px;
          const Y = y0 + py;
          if (X >= x1 || Y >= y1) continue;
          const i = (Y * W + X) * 4;
          const a = al[k] * ga;
          out[i] += (r0 - out[i]) * a;
          out[i + 1] += (g0 - out[i + 1]) * a;
          out[i + 2] += (b0 - out[i + 2]) * a;
        }
      }
    }
  }
}

export interface PostFX {
  grain: number;
  vignette: number;
  scanlines: number;
  glitch: number;
}

let vigCache: { w: number; h: number; amt: number; f: Float32Array } | null = null;

/** Analog post-processing: grain, vignette, scanlines and a subtle glitch. Deterministic per frame. */
export function applyPost(out: Uint8ClampedArray, W: number, H: number, fx: PostFX, frame: number, seed: number) {
  if (fx.vignette > 0) {
    if (!vigCache || vigCache.w !== W || vigCache.h !== H || vigCache.amt !== fx.vignette) {
      const f = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        const dy = (y / H - 0.5) * 2;
        for (let x = 0; x < W; x++) {
          const dx = (x / W - 0.5) * 2;
          const d = Math.min(1, (dx * dx * 0.55 + dy * dy * 0.8) * 0.75);
          f[y * W + x] = 1 - fx.vignette * d * d * 1.1;
        }
      }
      vigCache = { w: W, h: H, amt: fx.vignette, f };
    }
  }
  const vf = fx.vignette > 0 ? vigCache!.f : null;
  let s = (Math.imul(frame + 1, 0x9e3779b1) ^ seed) >>> 0;
  const g = fx.grain * 38;
  const sl = fx.scanlines * 0.28;
  for (let y = 0; y < H; y++) {
    const scan = sl > 0 && (y & 1) === 1 ? 1 - sl : 1;
    let i = y * W * 4;
    for (let x = 0; x < W; x++, i += 4) {
      let m = scan;
      if (vf) m *= vf[y * W + x];
      let n = 0;
      if (g > 0) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        n = ((s >>> 0) / 4294967296 - 0.5) * g;
      }
      out[i] = out[i] * m + n;
      out[i + 1] = out[i + 1] * m + n * 0.8;
      out[i + 2] = out[i + 2] * m + n * 0.8;
    }
  }
  if (fx.glitch > 0) {
    const bands = 6;
    for (let b = 0; b < bands; b++) {
      if (hashf(frame, b, seed, 77) > fx.glitch * 0.35) continue;
      const by = Math.floor(hashf(frame, b, seed, 78) * H);
      const bh = Math.max(2, Math.floor(hashf(frame, b, seed, 79) * H * 0.04 * (0.3 + fx.glitch)));
      const shift = Math.round((hashf(frame, b, seed, 80) - 0.5) * W * 0.03 * fx.glitch) * 4;
      for (let y = by; y < Math.min(H, by + bh); y++) {
        const row = out.subarray(y * W * 4, (y + 1) * W * 4);
        if (shift > 0) row.copyWithin(shift, 0, row.length - shift);
        else if (shift < 0) row.copyWithin(0, -shift, row.length);
        // slight red channel offset
        for (let x = W - 1; x >= 3; x--) row[x * 4] = row[(x - 3) * 4];
      }
    }
  }
}
