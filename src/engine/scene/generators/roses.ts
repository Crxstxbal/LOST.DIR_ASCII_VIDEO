import { hexToRgb, mix, type RGB } from '../../core/color';
import { smoothstep } from '../../core/math';
import { fbm2, noise2 } from '../../core/noise';
import { hashf } from '../../core/rng';
import type { Painter } from '../../raster/Painter';
import type { FrameCtx, Generator } from '../types';
import { fogAt } from './atmosphere';
import { forCells } from './terrain';

const C = (h: string) => hexToRgb(h);
const STEM: RGB = C('#1E1410');
const LEAF: RGB = C('#1A1A12');
const LEAF_LIT: RGB = C('#3A2E22');

/** Wind sway of a plant at (x,z): gusts travel across the field as waves. */
export function swayAt(ctx: FrameCtx, x: number, z: number, seed: number): number {
  const t = ctx.t;
  const w = ctx.wind(t, x, 0.8, z) / 4.5; // ~ -1..1 in strength units
  const wave = noise2(x * 0.22 - t * 0.9 * Math.sign(w || 1), z * 0.22, seed) * 0.5 + 0.5;
  const flutter = Math.sin(t * (2.2 + hashf(seed, Math.floor(x * 7), Math.floor(z * 7)) * 1.5) + x * 3.1) * 0.04;
  return w * (0.18 + 0.32 * wave) + flutter;
}

/** Ground of the field: dark foliage carpet with a red bloom texture that holds at any distance. */
export const roseGround: Generator = (ctx, layer, out) => {
  const v = ctx.view;
  const seed = ctx.seed + 610;
  const pal = ctx.palette;
  const bloomDensity: number = (layer.bloom ?? 0.55) * (ctx.params.roseDensity ?? 1);
  const t = ctx.t;
  out.add(5e8, (P) => {
    P.shade(Math.max(0, v.horizonY - 3), v.vh, (sx, sy, o) => {
      const g = v.ground(sx, sy);
      if (!g) return false;
      const { x, z, dist } = g;
      // the pixel footprint grows with distance: pick a bloom scale the zone grid can resolve
      const foot = dist / v.f * 6;
      const sc = Math.max(0.35, foot * 1.2);
      const sw = swayAt(ctx, x, z, seed) * 0.6;
      const n = fbm2((x + sw) / sc, z / sc, 2, seed + 1) * 0.5 + 0.5;
      const clump = fbm2(x * 0.06, z * 0.06, 3, seed + 2) * 0.5 + 0.5;
      const bloom = smoothstep(1 - bloomDensity * (0.6 + clump * 0.7), 1.02 - bloomDensity * 0.25, n);
      const hueV = noise2(x * 0.03, z * 0.03, seed + 3) * 0.5 + 0.5;
      const flower = mix(pal.blood, pal.red, hueV * 0.8);
      const paleFl = mix(flower, pal.pale, smoothstep(0.75, 1, hueV) * 0.6);
      let c = mix(mix(LEAF, LEAF_LIT, clump * 0.6), paleFl, bloom);
      let dens = 0.32 + bloom * 0.38 + (clump - 0.5) * 0.15;
      // shimmer of gusts passing over the field
      const gust = noise2(x * 0.08 - t * 0.6, z * 0.08, seed + 4) * 0.5 + 0.5;
      c = mix(c, pal.pale, gust * 0.06 * bloom);
      const fog = fogAt(ctx, dist);
      c = mix(c, ctx.fogColor, fog);
      dens = dens + (0.2 - dens) * fog;
      o[0] = c[0];
      o[1] = c[1];
      o[2] = c[2];
      o[3] = 1;
      o[4] = dens;
      return true;
    });
  });
};

function drawRoseBloom(P: Painter, x: number, y: number, r: number, spin: number, c: RGB, edge: RGB, inner: RGB, detail: number, alpha: number) {
  if (detail < 1) {
    P.beginPath();
    P.ellipse(x, y, r, r * 0.8);
    P.fill({ color: c, density: 0.7, alpha });
    return;
  }
  // outer petals
  const n = 5;
  for (let k = 0; k < n; k++) {
    const a = spin + (k / n) * Math.PI * 2;
    P.beginPath();
    P.ellipse(x + Math.cos(a) * r * 0.45, y + Math.sin(a) * r * 0.32, r * 0.62, r * 0.46, a);
    P.fill({ color: mix(c, [0, 0, 0], 0.15 + 0.15 * (k % 2)), density: 0.62, alpha });
  }
  // cup + spiral of inner petals
  P.beginPath();
  P.ellipse(x, y - r * 0.08, r * 0.58, r * 0.46);
  P.fill({ color: c, density: 0.7, alpha });
  for (let k = 0; k < 3; k++) {
    const rr = r * (0.48 - k * 0.13);
    P.beginPath();
    P.ellipse(x + Math.cos(spin + k) * r * 0.05, y - r * 0.1, rr, rr * 0.75, spin + k * 1.7, Math.PI * 0.1, Math.PI * 1.35);
    P.stroke({ color: k === 0 ? edge : inner, density: 0.85, alpha: alpha * 0.9 }, Math.max(0.7, r * 0.12));
  }
  P.beginPath();
  P.ellipse(x, y - r * 0.12, r * 0.12, r * 0.09);
  P.fill({ color: inner, density: 0.3, alpha });
  // iconic ASCII rose: '@' head, '(' ')' outer petals when there is room
  const cw = P.vw / P.cols;
  if (r > cw * 0.45) {
    P.hint(x, y - r * 0.05, '@');
    if (r > cw * 1.3) {
      P.hint(x - r * 0.85, y, '(');
      P.hint(x + r * 0.85, y, ')');
    }
  }
}

/** Glyph hints along a stem: '|', '/' or '\\' depending on its slope. */
function stemHints(P: Painter, x0: number, y0: number, x1: number, y1: number) {
  const ch = P.vh / P.rows;
  const n = Math.floor(Math.abs(y0 - y1) / ch);
  if (n < 2) return;
  const slope = (x1 - x0) / Math.max(1e-3, y0 - y1);
  const g = slope > 0.35 ? '/' : slope < -0.35 ? '\\' : '|';
  for (let k = 1; k < n; k++) {
    const f = k / n;
    P.hint(x0 + (x1 - x0) * f * f, y0 + (y1 - y0) * f, g);
  }
}

/** Instanced roses with level of detail. Near roses are fully drawn and can hide the walker. */
export const roses: Generator = (ctx, layer, out) => {
  const v = ctx.view;
  const seed = ctx.seed + 640;
  const pal = ctx.palette;
  const density: number = (layer.density ?? 0.7) * (ctx.params.roseDensity ?? 1);
  const hMul: number = ctx.params.roseHeight ?? 1;
  const far: number = layer.far ?? 45;
  const bands: [number, number, number][] = [
    [0.6, 12, 0.42],
    [12, 26, 0.75],
    [26, far, 1.4],
  ];
  for (const [zn, zf, cell] of bands) {
    forCells(ctx, zn, zf, cell, (ix, iz) => {
      const h0 = hashf(seed, ix, iz, Math.round(cell * 100));
      if (h0 > density) return;
      const x = (ix + 0.1 + hashf(seed, ix, iz, 1) * 0.8) * cell;
      const z = (iz + 0.1 + hashf(seed, ix, iz, 2) * 0.8) * cell;
      const depth = z - v.cz;
      if (depth < zn || depth > zf) return;
      const height = (0.45 + hashf(seed, ix, iz, 3) * 0.55) * hMul;
      const base = v.project(x, 0, z);
      if (!base) return;
      const bloomR = 0.05 + hashf(seed, ix, iz, 4) * 0.035;
      const rpx = bloomR * base.s;
      // tiny roses are already represented by the ground's bloom texture
      if (rpx < 1.7) return;
      if (base.x < -height * base.s || base.x > v.vw + height * base.s) return;
      const sway = swayAt(ctx, x, z, seed);
      const top = v.project(x + sway * height * 0.55, height - Math.abs(sway) * height * 0.12, z);
      if (!top) return;
      const fog = fogAt(ctx, depth);
      const hue = hashf(seed, ix, iz, 5);
      let bc = hue < 0.55 ? pal.blood : hue < 0.85 ? pal.red : mix(pal.pale, pal.red, 0.35);
      if (hue > 0.97) bc = mix(pal.pale, [0.85, 0.82, 0.8], 0.5); // rare pale-white roses
      const flower = mix(bc, ctx.fogColor, fog);
      const edgeC = mix(mix(bc, pal.pale, 0.45), ctx.fogColor, fog);
      const innerC = mix(mix(bc, [0, 0, 0], 0.55), ctx.fogColor, fog);
      const stemC = mix(STEM, ctx.fogColor, fog);
      const leafC = mix(LEAF, ctx.fogColor, fog);
      const detail = rpx > 4 ? 1 : 0;
      const spin = hashf(seed, ix, iz, 6) * 6.28 + sway * 0.8;
      out.add(depth, (P) => {
        const s = base.s;
        // LOD relative to the character grid of this pass: petals, inner spiral and leaves
        // only where a rose spans enough cells to show them (otherwise blob + '@' hint)
        const cell = P.vw / P.cols;
        const det = rpx > Math.max(4, cell * 1.5) ? detail : 0;
        if (rpx > Math.max(3.2, cell * 0.9)) {
          // foliage clump around the stem
          const fw = 0.22 * s;
          P.beginPath();
          P.ellipse(base.x + sway * 0.15 * s, base.y - height * 0.32 * s * Math.cos(v.pitch), fw, height * 0.38 * s);
          P.fill({ color: leafC, density: 0.42, alpha: 0.95 });
          // stem
          P.beginPath();
          P.moveTo(base.x, base.y);
          P.quadTo(base.x + (top.x - base.x) * 0.2, (base.y + top.y) / 2, top.x, top.y);
          P.stroke({ color: stemC, density: 0.55 }, Math.max(0.6, 0.012 * s));
          if (det) stemHints(P, base.x, base.y, top.x, top.y + rpx);
          if (det) {
            for (const side of [-1, 1]) {
              const ly = base.y + (top.y - base.y) * (side > 0 ? 0.45 : 0.62);
              const lx = base.x + (top.x - base.x) * (side > 0 ? 0.45 : 0.62);
              P.beginPath();
              P.ellipse(lx + side * 0.05 * s, ly, 0.055 * s, 0.022 * s, side * 0.5 + sway);
              P.fill({ color: mix(leafC, LEAF_LIT, 0.4), density: 0.55 });
            }
          }
        }
        drawRoseBloom(P, top.x, top.y, rpx, spin, flower, edgeC, innerC, det, 1);
      });
    });
  }
};
