import { clamp, lerp } from './math';

/** Linear-ish RGB triple in 0..1 (we stay in sRGB space for simplicity and determinism). */
export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: RGB): string {
  const f = (v: number) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0');
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}

export function css(c: RGB, a = 1): string {
  const r = Math.round(clamp(c[0]) * 255);
  const g = Math.round(clamp(c[1]) * 255);
  const b = Math.round(clamp(c[2]) * 255);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${clamp(a)})`;
}

export const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const mul = (a: RGB, s: number): RGB => [a[0] * s, a[1] * s, a[2] * s];

/** Luminance weighted toward red (the LOST.DIR visualizer used 0.75/0.15/0.10). */
export const redLum = (c: RGB) => c[0] * 0.6 + c[1] * 0.3 + c[2] * 0.1;
export const lum = (c: RGB) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

export interface Palette {
  black: string;
  sepia: string;
  blood: string;
  red: string;
  pale: string;
}

export const LOSTDIR_PALETTE: Palette = {
  black: '#100A0D',
  sepia: '#49302E',
  blood: '#8E292D',
  red: '#E33B38',
  pale: '#E4A18B',
};

/** Resolved palette as RGB for fast use. */
export interface PaletteRGB {
  black: RGB;
  sepia: RGB;
  blood: RGB;
  red: RGB;
  pale: RGB;
  ramp: RGB[];
}

export function resolvePalette(p: Palette): PaletteRGB {
  const black = hexToRgb(p.black);
  const sepia = hexToRgb(p.sepia);
  const blood = hexToRgb(p.blood);
  const red = hexToRgb(p.red);
  const pale = hexToRgb(p.pale);
  return { black, sepia, blood, red, pale, ramp: [black, sepia, blood, red, pale] };
}

/** Sample the 5-stop palette ramp at t∈[0,1]. */
export function rampAt(ramp: RGB[], t: number): RGB {
  t = clamp(t) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(t));
  return mix(ramp[i], ramp[i + 1], t - i);
}
