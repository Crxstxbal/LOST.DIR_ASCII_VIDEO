import { hexToRgb, mix, type RGB } from '../../core/color';
import { clamp, lerp, smoothstep } from '../../core/math';
import { cellEdge, fbm2, noise2 } from '../../core/noise';
import { hashf } from '../../core/rng';
import type { Projected } from '../../camera/Camera';
import type { FrameCtx, Generator } from '../types';
import { fogAt } from './atmosphere';

const col = (ctx: FrameCtx, v: any, fallback: RGB): RGB => {
  if (typeof v !== 'string') return fallback;
  const p = ctx.palette as any;
  return p[v] ?? hexToRgb(v);
};

/** Ground is shaded at 75 % of the zone resolution (≈0.56× the evaluations; cracks stay readable). */
const GROUND_RES = 0.75;

/** Perspective ground plane shaded per pixel: undulation, cracks, grit, fog. */
export const ground: Generator = (ctx, layer, out) => {
  const v = ctx.view;
  const seed = ctx.seed + 40;
  const dark = col(ctx, layer.dark ?? 'black', ctx.palette.black);
  const light = col(ctx, layer.light ?? 'sepia', ctx.palette.sepia);
  const glowC = col(ctx, layer.glow ?? 'blood', ctx.palette.blood);
  const cracks: number = (layer.cracks ?? 0.7) * (ctx.params.cracks ?? 1);
  const hy = v.horizonY;
  // the ground does not depend on time: with a still camera the band is reused
  const key = [
    'ground',
    seed,
    v.cx, v.cy, v.cz, v.f, v.pitch, v.vw, v.vh,
    dark.join(), light.join(), glowC.join(), ctx.fogColor.join(),
    cracks, ctx.grade.fog, ctx.params.fogDensity ?? 1,
  ].join('|');
  out.add(5e8, (P) => {
    P.shade(Math.max(0, hy - 4), v.vh, (sx, sy, o) => {
      const g = v.ground(sx, sy);
      if (!g) return false;
      const { x, z, dist } = g;
      const aa = clamp(1 - dist / 90); // detail fades with distance (anti-aliasing)
      const large = fbm2(x * 0.025, z * 0.025, 3, seed) * 0.5 + 0.5;
      const midN = fbm2(x * 0.3, z * 0.3, 3, seed + 3) * 0.5 + 0.5;
      // pseudo-normal from the mid noise → light from the horizon side
      const sl = (fbm2(x * 0.3 + 0.08, z * 0.3, 2, seed + 3) - fbm2(x * 0.3 - 0.08, z * 0.3, 2, seed + 3)) * aa;
      let c = mix(dark, light, clamp(0.2 + large * 0.45 + (midN - 0.5) * 0.45 * aa + sl * 0.9));
      let dens = 0.2 + (midN - 0.5) * 0.25 * aa + large * 0.12 + Math.abs(sl) * 0.5;
      if (cracks > 0 && dist < 70) {
        // domain-warped cellular edges → irregular, broken cracks (not tiles)
        const wx = fbm2(x * 0.12, z * 0.12, 2, seed + 21) * 1.4;
        const wz = fbm2(x * 0.12 + 7, z * 0.12, 2, seed + 22) * 1.4;
        const e = cellEdge(x * 0.32 + wx, z * 0.32 + wz, seed + 9);
        const mask = smoothstep(0.35, 0.6, fbm2(x * 0.09, z * 0.09, 2, seed + 23) * 0.5 + 0.5);
        const cr = (1 - smoothstep(0.0, 0.035, e)) * cracks * aa * mask;
        c = mix(c, [0, 0, 0], cr * 0.85);
        dens = dens * (1 - cr) + cr * 0.05;
        // lit lip along the crack
        const lip = (smoothstep(0.035, 0.06, e) - smoothstep(0.06, 0.1, e)) * cracks * aa * mask;
        c = mix(c, light, lip * 0.5);
        dens += lip * 0.25;
      }
      const grit = noise2(x * 4, z * 4, seed + 11) * 0.5 + 0.5;
      dens += (grit - 0.5) * 0.22 * aa;
      // sky reflection / glow toward the horizon
      const hz = smoothstep(8, 220, dist);
      c = mix(c, glowC, hz * 0.55);
      dens += hz * 0.12;
      const fog = fogAt(ctx, dist);
      c = mix(c, ctx.fogColor, fog);
      dens = lerp(dens, 0.18, fog);
      o[0] = c[0];
      o[1] = c[1];
      o[2] = c[2];
      o[3] = 1;
      o[4] = dens;
      return true;
    }, -Infinity, Infinity, key, GROUND_RES);
  });
};

/** Iterate world grid cells (x,z) visible from the camera within a depth band. */
export function forCells(ctx: FrameCtx, zNear: number, zFar: number, cell: number, fn: (ix: number, iz: number) => void) {
  const v = ctx.view;
  const z0 = Math.floor((v.cz + zNear) / cell);
  const z1 = Math.floor((v.cz + zFar) / cell);
  for (let iz = z0; iz <= z1; iz++) {
    const depth = iz * cell - v.cz;
    const half = (v.vw / v.f) * Math.max(depth, 1) * 0.62 + cell * 2;
    const x0 = Math.floor((v.cx - half) / cell);
    const x1 = Math.floor((v.cx + half) / cell);
    for (let ix = x0; ix <= x1; ix++) fn(ix, iz);
  }
}

/** The black spires of the wasteland, with long projected shadows (light behind them). */
export const spires: Generator = (ctx, layer, out) => {
  const v = ctx.view;
  const seed = ctx.seed + 70;
  const density: number = (layer.density ?? 0.35) * (ctx.params.spireDensity ?? 1);
  const hMul: number = ctx.params.spireHeight ?? 1;
  const cell: number = layer.cell ?? 26;
  // spires stand behind the walker (never between lens and subject)
  const near: number = Math.max(layer.near ?? 14, ctx.actor ? ctx.actor.depth + 5 : 0);
  const far: number = layer.far ?? 900;
  const body = col(ctx, layer.color ?? '#0A0607', [0.04, 0.02, 0.03]);
  const rimC = col(ctx, layer.rim ?? 'red', ctx.palette.red);
  const shadowLen: number = ctx.params.shadowLength ?? 1.8;
  const sdx = (layer.shadowDirX ?? 0.55) * -ctx.light.side;
  const sdz = layer.shadowDirZ ?? -1;
  // bands get coarser with distance
  const bands = [
    [near, 60, cell],
    [60, 220, cell * 2.2],
    [220, far, cell * 5],
  ];
  for (const [zn, zf, cs] of bands) {
    // fewer, more monumental spires close to the lens; denser rows toward the horizon
    const dBand = zn === near ? density * 0.45 : density;
    forCells(ctx, zn, zf, cs, (ix, iz) => {
      if (hashf(seed, ix, iz, Math.round(cs)) > dBand) return;
      const x = (ix + 0.2 + hashf(seed, ix, iz, 1) * 0.6) * cs;
      const z = (iz + 0.2 + hashf(seed, ix, iz, 2) * 0.6) * cs;
      const depth = z - v.cz;
      if (depth < zn || depth > zf) return;
      const h = (9 + Math.pow(hashf(seed, ix, iz, 3), 1.4) * 30) * hMul;
      const r = h * (0.07 + hashf(seed, ix, iz, 4) * 0.05);
      const lean = (hashf(seed, ix, iz, 5) - 0.5) * h * 0.08;
      const fog = fogAt(ctx, depth);
      const c = mix(body, ctx.fogColor, fog * 0.92);
      const rim = mix(rimC, ctx.fogColor, fog);
      const pts3: [number, number][] = [];
      // concave needle with a flared skirt (profile in x/y)
      const prof = [
        [0, 1],
        [0.08, 0.6],
        [0.18, 0.32],
        [0.42, 0.13],
        [1, 0],
      ];
      for (const [px, py] of prof) pts3.push([px, py]);
      const P3 = (sx: number, sy: number): Projected | null => v.project(x + sx * r + lean * sy, sy * h, z);
      // shadow on the ground (drawn before the spire)
      const sh: (Projected | null)[] = [
        v.project(x - r * 0.9, 0, z),
        v.project(x + sdx * h * shadowLen - r * 0.1, 0, z + sdz * h * shadowLen),
        v.project(x + sdx * h * shadowLen + r * 0.1, 0, z + sdz * h * shadowLen),
        v.project(x + r * 0.9, 0, z),
      ];
      out.add(depth + 0.5, (P) => {
        if (sh.some((p) => !p)) return;
        P.beginPath();
        P.polygon(sh as Projected[]);
        P.fill({ color: [0.02, 0.01, 0.012], density: 0.1, alpha: 0.6 * (1 - fog) });
      });
      out.add(depth, (P) => {
        const right: Projected[] = [];
        const left: Projected[] = [];
        for (const [px, py] of prof) {
          const a = P3(px, py);
          const b = P3(-px, py);
          if (!a || !b) return;
          right.push(a);
          left.push(b);
        }
        P.beginPath();
        P.smoothPath([...right, ...left.reverse().slice(1)], true, 0.3);
        P.fill({ color: c, density: 0.5 - fog * 0.25 });
        // rim light on the side facing the light
        const edge = ctx.light.side > 0 ? right : left.reverse();
        P.beginPath();
        P.smoothPath(edge, false, 0.4);
        P.stroke({ color: rim, density: 0.7, alpha: 0.55 * (1 - fog * 0.7) * ctx.light.rim }, Math.max(0.8, r * 0.12 * edge[edge.length - 1].s));
      });
    });
  }
};

/** Scattered rocks / debris (and foreground stones when near the lens). */
export const rocks: Generator = (ctx, layer, out) => {
  const v = ctx.view;
  const seed = ctx.seed + (layer.seed ?? 120);
  const density: number = (layer.density ?? 0.25) * (ctx.params.debris ?? 1);
  const cell: number = layer.cell ?? 2.2;
  const near: number = layer.near ?? 2;
  const far: number = layer.far ?? 50;
  const sizeMul: number = layer.size ?? 1;
  const base = col(ctx, layer.color ?? 'black', ctx.palette.black);
  const lit = col(ctx, layer.lit ?? 'sepia', ctx.palette.sepia);
  forCells(ctx, near, far, cell, (ix, iz) => {
    if (hashf(seed, ix, iz) > density) return;
    const x = (ix + hashf(seed, ix, iz, 1)) * cell;
    const z = (iz + hashf(seed, ix, iz, 2)) * cell;
    const depth = z - v.cz;
    if (depth < near || depth > far) return;
    const r = (0.08 + Math.pow(hashf(seed, ix, iz, 3), 2.5) * 0.5) * sizeMul;
    const p = v.project(x, 0, z);
    if (!p) return;
    if (p.x < -r * p.s * 2 || p.x > v.vw + r * p.s * 2) return;
    const fog = fogAt(ctx, depth);
    const c = mix(base, ctx.fogColor, fog);
    const cl = mix(lit, ctx.fogColor, fog);
    const nv = 7;
    const shape: { x: number; y: number }[] = [];
    for (let k = 0; k < nv; k++) {
      const a = Math.PI + (k / (nv - 1)) * Math.PI;
      const rr = r * (0.7 + hashf(seed, ix, iz, 10 + k) * 0.5);
      shape.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr * (0.6 + hashf(seed, ix, iz, 5) * 0.5) });
    }
    out.add(depth, (P) => {
      const s = p.s;
      const pts = shape.map((q) => ({ x: p.x + q.x * s, y: p.y + q.y * s * Math.cos(v.pitch) + Math.abs(q.x) * s * 0.0 }));
      P.beginPath();
      P.smoothPath(pts, true, 0.3);
      P.fill({ color: c, density: 0.5 });
      P.beginPath();
      P.smoothPath(pts.slice(0, 4), false, 0.4);
      P.stroke({ color: cl, density: 0.6, alpha: 0.6 }, Math.max(0.7, r * s * 0.12));
    });
  });
};
