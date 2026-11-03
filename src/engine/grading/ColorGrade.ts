import { hexToRgb, rampAt, type PaletteRGB, type RGB } from '../core/color';
import { clamp, smoothstep } from '../core/math';

export interface GradeParams {
  /** Stops (+/-). */
  exposure: number;
  /** Additive, -1..1. */
  brightness: number;
  /** Multiplier around mid-grey, 1 = neutral. */
  contrast: number;
  /** 0 = monochrome, 1 = neutral, >1 = boosted. */
  saturation: number;
  /** 0 = muted / cold, 0.5 = neutral, 1 = blood red dominates. */
  redIntensity: number;
  /** How strongly colours are remapped onto the 5-colour LOST.DIR palette ramp. */
  paletteAmount: number;
  shadowColor: string;
  highlightColor: string;
  shadowTint: number;
  highlightTint: number;
  /** Atmospheric fog amount used by scene generators (0..1). */
  fog: number;
}

export const NUMERIC_GRADE_KEYS = [
  'exposure',
  'brightness',
  'contrast',
  'saturation',
  'redIntensity',
  'paletteAmount',
  'shadowTint',
  'highlightTint',
  'fog',
] as const;
export type NumericGradeKey = (typeof NUMERIC_GRADE_KEYS)[number];

export interface GradeKey {
  t: number;
  values: Partial<Record<NumericGradeKey, number>>;
}

export const DEFAULT_GRADE: GradeParams = {
  exposure: 0,
  brightness: 0,
  contrast: 1.1,
  saturation: 1,
  redIntensity: 0.6,
  paletteAmount: 0.55,
  shadowColor: '#100A0D',
  highlightColor: '#E4A18B',
  shadowTint: 0.25,
  highlightTint: 0.15,
  fog: 0.45,
};

/** Evaluate grade at shot-time t: base values overridden by interpolated keyframes. */
export function evalGrade(base: GradeParams, keys: GradeKey[] | undefined, t: number): GradeParams {
  const g: GradeParams = { ...base };
  if (!keys || !keys.length) return g;
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  for (const k of NUMERIC_GRADE_KEYS) {
    const ks = sorted.filter((key) => key.values[k] !== undefined);
    if (!ks.length) continue;
    if (t <= ks[0].t) g[k] = ks[0].values[k]!;
    else if (t >= ks[ks.length - 1].t) g[k] = ks[ks.length - 1].values[k]!;
    else {
      for (let i = 0; i < ks.length - 1; i++) {
        if (t >= ks[i].t && t <= ks[i + 1].t) {
          const u = smoothstep(ks[i].t, ks[i + 1].t, t);
          g[k] = ks[i].values[k]! + (ks[i + 1].values[k]! - ks[i].values[k]!) * u;
          break;
        }
      }
    }
  }
  return g;
}

export type Grader = (c: RGB) => RGB;

/** Build a per-cell colour grading function. */
export function makeGrader(g: GradeParams, pal: PaletteRGB): Grader {
  const expo = Math.pow(2, g.exposure);
  const sh = hexToRgb(g.shadowColor);
  const hi = hexToRgb(g.highlightColor);
  const red = clamp(g.redIntensity);
  const rk = (red - 0.5) * 2; // -1..1
  return (c: RGB): RGB => {
    let r = c[0] * expo;
    let gg = c[1] * expo;
    let b = c[2] * expo;
    // palette remap by red-weighted luminance
    const L = clamp(r * 0.6 + gg * 0.3 + b * 0.1);
    if (g.paletteAmount > 0) {
      const p = rampAt(pal.ramp, L);
      r += (p[0] - r) * g.paletteAmount;
      gg += (p[1] - gg) * g.paletteAmount;
      b += (p[2] - b) * g.paletteAmount;
    }
    // red intensity: shift energy into / out of the red channel
    if (rk > 0) {
      const m = (gg + b) * 0.5;
      r = r + (Math.max(r, m * 1.4) - r) * rk * 0.8;
      gg *= 1 - 0.45 * rk;
      b *= 1 - 0.35 * rk;
    } else if (rk < 0) {
      const m = (r + gg + b) / 3;
      const k = -rk * 0.7;
      r += (m - r) * k;
      gg += (m - gg) * k;
      b += (m * 1.05 - b) * k;
    }
    // contrast + brightness
    r = (r - 0.5) * g.contrast + 0.5 + g.brightness;
    gg = (gg - 0.5) * g.contrast + 0.5 + g.brightness;
    b = (b - 0.5) * g.contrast + 0.5 + g.brightness;
    // saturation
    const l2 = r * 0.299 + gg * 0.587 + b * 0.114;
    r = l2 + (r - l2) * g.saturation;
    gg = l2 + (gg - l2) * g.saturation;
    b = l2 + (b - l2) * g.saturation;
    // split toning
    const L3 = clamp(l2);
    const ws = (1 - L3) * (1 - L3) * g.shadowTint;
    const wh = L3 * L3 * g.highlightTint;
    r += (sh[0] - r) * ws + (hi[0] - r) * wh;
    gg += (sh[1] - gg) * ws + (hi[1] - gg) * wh;
    b += (sh[2] - b) * ws + (hi[2] - b) * wh;
    return [clamp(r), clamp(gg), clamp(b)];
  };
}
