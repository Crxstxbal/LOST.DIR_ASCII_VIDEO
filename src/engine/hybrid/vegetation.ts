import { mix, type RGB } from '../core/color';
import { clamp } from '../core/math';
import { hashf } from '../core/rng';
import type { WindField } from '../scene/types';
import type { Camera3D } from './camera3d';
import { KIND_VEG, type GBuffer } from './gbuffer';
import { rasterDisc, rasterSegment } from './rasterizer';
import { stemChar, type StrokeBuffer } from './glyphStrokes';
import { clumpAt, heightAt, type TerrainParams } from './terrain';
import type { HybridLight } from './lighting';

export interface VegParams {
  /** rose density (0..1.5) */
  density: number;
  /** distance limit for rose instances (m) */
  far: number;
  /** stem height multiplier */
  height: number;
  /** dry undergrowth blades near the camera (0..2) */
  blades: number;
  /** falling petals (0..3) */
  petals: number;
  /** free-glyph amount (0 = grid only) */
  strokes: number;
}

export interface VegColors {
  flowers: RGB[];
  stem: RGB;
  leaf: RGB;
  blades: RGB[];
}

export interface VegCtx {
  G: GBuffer;
  cam: Camera3D;
  T: TerrainParams;
  P: VegParams;
  wind: WindField;
  t: number;
  /** actor ground positions: [0] = now, then progressively older (for the wake) */
  trail: { x: number; z: number }[];
  S: StrokeBuffer;
  seed: number;
  colors: VegColors;
  Lt: HybridLight;
  fog: number;
  cols: number;
  rows: number;
}

export interface VegStats {
  roses: number;
  blades: number;
  petals: number;
}

const tc = new Float64Array(3);

/** Simple lit colour for a free glyph (up-facing, same fog model as the G-buffer). */
function strokeLight(V: VegCtx, c: RGB, depth: number, wy: number, rim: number): RGB {
  const Lt = V.Lt;
  const key = clamp(Lt.L[1] * 0.8 + 0.35);
  let r = c[0] * (Lt.ambient[0] * Lt.ambientI + Lt.key[0] * Lt.keyI * key) + Lt.glow[0] * rim;
  let g = c[1] * (Lt.ambient[1] * Lt.ambientI + Lt.key[1] * Lt.keyI * key) + Lt.glow[1] * rim;
  let b = c[2] * (Lt.ambient[2] * Lt.ambientI + Lt.key[2] * Lt.keyI * key) + Lt.glow[2] * rim;
  const hk = Math.exp(-Math.max(0, wy) * Lt.fogHeight);
  const fog = clamp(1 - Math.exp(-depth * Lt.fogDensity * V.fog * (0.35 + 0.65 * hk)));
  r += (Lt.fog[0] - r) * fog;
  g += (Lt.fog[1] - g) * fog;
  b += (Lt.fog[2] - b) * fog;
  return [r, g, b];
}

/** Bend (radians, as an x/z vector) from wind and from the actor's wake. */
export function bendAt(V: Pick<VegCtx, 'wind' | 't' | 'trail'>, x: number, y: number, z: number, phase: number, out: { bx: number; bz: number }) {
  const w = V.wind(V.t, x, y, z);
  let bx = clamp(w / 5, -1, 1) * 0.32 + 0.06 * Math.sin(V.t * (1.6 + phase) + x * 2.3 + z * 1.7);
  let bz = 0.03 * Math.sin(V.t * (1.3 + phase) + z * 2.9);
  // local reaction to the walker: stems lean away from the recent path and recover
  const n = V.trail.length;
  for (let k = 0; k < n; k++) {
    const p = V.trail[k];
    const dx = x - p.x;
    const dz = z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 2.2) continue;
    const d = Math.sqrt(d2) + 1e-3;
    const f = Math.exp(-d2 / 0.3) * (1 - (k / n) * 0.8) * 0.95;
    bx += (dx / d) * f;
    bz += (dz / d) * f;
  }
  out.bx = bx;
  out.bz = bz;
}

const bend = { bx: 0, bz: 0 };

/** Roses (instanced, LOD by projected size) + undergrowth blades + falling petals. */
export function drawVegetation(V: VegCtx): VegStats {
  const { G, cam, T, P, S } = V;
  const kx = G.w / cam.vw;
  const ky = G.h / cam.vh;
  const cellW = cam.vw / V.cols;
  const cellH = cam.vh / V.rows;
  const cx = cam.pos[0];
  const cz = cam.pos[2];
  const stats: VegStats = { roses: 0, blades: 0, petals: 0 };
  const towardCam: [number, number, number] = [-cam.F[0], -cam.F[1], -cam.F[2]];
  const bands: [number, number, number][] = [
    [0, 9, 0.34],
    [9, 24, 0.62],
    [24, P.far, 1.3],
  ];
  for (const [bi, [d0, d1, cell]] of bands.entries()) {
    if (d0 >= P.far) break;
    const R = d1 + 1;
    const ix0 = Math.floor((cx - R) / cell);
    const ix1 = Math.ceil((cx + R) / cell);
    const iz0 = Math.floor((cz - R) / cell);
    const iz1 = Math.ceil((cz + R) / cell);
    for (let iz = iz0; iz <= iz1; iz++)
      for (let ix = ix0; ix <= ix1; ix++) {
        const h0 = hashf(V.seed, ix, iz, bi + 1);
        if (h0 > P.density * 1.2) continue;
        const x = (ix + 0.1 + hashf(V.seed, ix, iz, 11) * 0.8) * cell;
        const z = (iz + 0.1 + hashf(V.seed, ix, iz, 12) * 0.8) * cell;
        const clump = clumpAt(T, x, z);
        if (h0 > P.density * (0.2 + 0.95 * clump)) continue;
        const y = heightAt(T, x, z);
        cam.toCam(x, y, z, tc);
        if (tc[2] < 0.25) continue;
        const dist = Math.hypot(x - cx, y - cam.pos[1], z - cz);
        if (dist < d0 || dist >= d1) continue;
        // nothing grows against the lens
        if (dist < 1.2) continue;
        const sB = cam.f / tc[2];
        const bxs = cam.px + tc[0] * sB;
        const bys = cam.py - tc[1] * sB;
        const hgt = (0.42 + 0.5 * hashf(V.seed, ix, iz, 13)) * P.height;
        if (bxs < -hgt * sB - 20 || bxs > cam.vw + hgt * sB + 20 || bys < -40 || bys > cam.vh + hgt * sB + 40) continue;
        const phase = hashf(V.seed, ix, iz, 14);
        bendAt(V, x, y, z, phase, bend);
        const b = Math.min(1.15, Math.hypot(bend.bx, bend.bz));
        const sx = b > 1e-4 ? (bend.bx / Math.hypot(bend.bx, bend.bz)) * Math.sin(b) : 0;
        const sz = b > 1e-4 ? (bend.bz / Math.hypot(bend.bx, bend.bz)) * Math.sin(b) : 0;
        const tx = x + sx * hgt;
        const ty = y + Math.cos(b) * hgt;
        const tz = z + sz * hgt;
        cam.toCam(tx, ty, tz, tc);
        if (tc[2] < 0.2) continue;
        const sT = cam.f / tc[2];
        const txs = cam.px + tc[0] * sT;
        const tys = cam.py - tc[1] * sT;
        const tDepth = tc[2];
        cam.toCam(x, y, z, tc);
        const bDepth = tc[2];
        const bloomR = (0.045 + 0.04 * hashf(V.seed, ix, iz, 15)) * (0.85 + 0.3 * clump);
        const rpx = Math.min(bloomR * sT, cellW * 4);
        const hue = hashf(V.seed, ix, iz, 16);
        const flower = V.colors.flowers[Math.floor(hue * V.colors.flowers.length * 0.999)];
        const flowerC = mix(flower, [0, 0, 0], 0.15 * hashf(V.seed, ix, iz, 17));
        stats.roses++;
        // --- G-buffer: stem, foliage clump, bloom (mass and colour for the grid glyphs)
        const stemLen = Math.hypot(txs - bxs, tys - bys);
        if (stemLen * ky > 1.2)
          rasterSegment(G, bxs * kx, bys * ky, bDepth, txs * kx, tys * ky, tDepth, V.colors.stem[0], V.colors.stem[1], V.colors.stem[2], towardCam[0], towardCam[1], towardCam[2], KIND_VEG, P.strokes > 0 ? 0.12 : 0.3);
        if (rpx > cellW * 0.25 && P.strokes <= 0) {
          const lx = x + sx * hgt * 0.3;
          const ly = y + hgt * 0.28;
          const lz = z + sz * hgt * 0.3;
          cam.toCam(lx, ly, lz, tc);
          if (tc[2] > 0.2) {
            const sL = cam.f / tc[2];
            const rr = 0.1 * sL;
            rasterDisc(G, (cam.px + tc[0] * sL) * kx, (cam.py - tc[1] * sL) * ky, rr * kx, rr * 0.6 * ky, tc[2], V.colors.leaf[0], V.colors.leaf[1], V.colors.leaf[2], 0, 1, 0, KIND_VEG, 0.35);
          }
        }
        // with free glyphs the G-buffer bloom is only a dim mass (occlusion + glow); the
        // flower itself is written in glyphs below, like the grass in the references
        const massK = P.strokes > 0 && rpx > cellW * 0.45 ? 0.55 : 1;
        rasterDisc(G, txs * kx, tys * ky, Math.max(0.55, rpx * kx), Math.max(0.55, rpx * ky * 0.85), tDepth, flowerC[0] * massK, flowerC[1] * massK, flowerC[2] * massK, towardCam[0] * 0.6, 0.8, towardCam[2] * 0.6, KIND_VEG, P.strokes > 0 ? (rpx > cellW * 0.45 ? 0.16 : 0.3) : 0.8);

        // --- free glyphs (world-anchored strokes)
        if (P.strokes <= 0 || rpx < cellW * 0.2 || dist > P.far * 0.75) continue;
        if (hashf(V.seed, ix, iz, 18) > P.strokes) continue;
        const stemC = strokeLight(V, V.colors.stem, (bDepth + tDepth) / 2, y + hgt / 2, 0.05);
        const nStem = Math.floor(stemLen / (cellH * 0.95));
        const ch = stemChar(txs - bxs, tys - bys);
        for (let k = 0; k < nStem; k++) {
          const f = (k + 0.5) / (nStem + 0.6);
          S.add(bxs + (txs - bxs) * f, bys + (tys - bys) * f, bDepth + (tDepth - bDepth) * f, ch, stemC, 0.85);
        }
        if (rpx > cellW * 0.6 && nStem >= 1) {
          const f = 0.35 + 0.2 * hashf(V.seed, ix, iz, 19);
          const side = hashf(V.seed, ix, iz, 20) > 0.5 ? 1 : -1;
          const leafC = strokeLight(V, V.colors.leaf, bDepth, y + hgt * f, 0.1);
          S.add(bxs + (txs - bxs) * f + side * cellW * 0.6, bys + (tys - bys) * f, bDepth + (tDepth - bDepth) * f - 0.01, side > 0 ? 39 : 44, leafC, 0.8);
        }
        const fl = strokeLight(V, flowerC, tDepth, ty, 0.25);
        const big = rpx > cellW * 1.0;
        const code = big ? 64 : rpx > cellW * 0.5 ? (hue > 0.7 ? 37 : 111) : hue > 0.5 ? 42 : 111; // @ % o *
        S.add(txs, tys, tDepth - 0.02, code, fl, 1);
        if (rpx > cellW * 1.1) {
          // a rose made of glyphs: ring(s) of petals around the '@' heart
          const spin = hashf(V.seed, ix, iz, 21) * 6.283;
          const edge = mix(fl, [0.95, 0.75, 0.68], 0.18);
          for (const [ringR, ringY] of rpx > cellW * 2.2 ? [[0.42, 0.34], [0.8, 0.62]] : [[0.75, 0.6]]) {
            const nR = Math.max(4, Math.min(14, Math.round((6.283 * ringR * rpx) / (cellW * 1.4))));
            for (let k = 0; k < nR; k++) {
              const a = spin + (k / nR) * 6.283;
              const ca = Math.cos(a);
              const code = ca < -0.55 ? 40 : ca > 0.55 ? 41 : ringR > 0.6 ? (Math.sin(a) < 0 ? 126 : 111) : 111; // ( ) ~ o
              S.add(txs + ca * ringR * rpx, tys + Math.sin(a) * ringY * rpx, tDepth - 0.015, code, ringR > 0.6 ? edge : fl, 0.95);
            }
          }
        }
      }
  }

  // --- dry undergrowth blades near the camera (strokes only)
  if (P.blades > 0 && P.strokes > 0) {
    // radius grows with the camera's height above the ground (top-down shots see a wide floor)
    const camH = Math.max(0, cam.pos[1] - heightAt(T, cx, cz));
    const R = Math.max(10, camH * 1.6);
    const cell = 0.24 * (R / 10);
    const ix0 = Math.floor((cx - R) / cell);
    const ix1 = Math.ceil((cx + R) / cell);
    const iz0 = Math.floor((cz - R) / cell);
    const iz1 = Math.ceil((cz + R) / cell);
    for (let iz = iz0; iz <= iz1; iz++)
      for (let ix = ix0; ix <= ix1; ix++) {
        if (hashf(V.seed + 5, ix, iz, 1) > 0.55 * P.blades) continue;
        const x = (ix + hashf(V.seed + 5, ix, iz, 2)) * cell;
        const z = (iz + hashf(V.seed + 5, ix, iz, 3)) * cell;
        const y = heightAt(T, x, z);
        cam.toCam(x, y, z, tc);
        if (tc[2] < 0.3) continue;
        const dist = Math.hypot(x - cx, y - cam.pos[1], z - cz);
        if (dist > R) continue;
        const sB = cam.f / tc[2];
        const bxs = cam.px + tc[0] * sB;
        const bys = cam.py - tc[1] * sB;
        if (bxs < -10 || bxs > cam.vw + 10 || bys < -10 || bys > cam.vh + 40) continue;
        const bDepth = tc[2];
        const hgt = 0.1 + 0.22 * hashf(V.seed + 5, ix, iz, 4);
        bendAt(V, x, y, z, hashf(V.seed + 5, ix, iz, 5), bend);
        const lean = hashf(V.seed + 5, ix, iz, 6) - 0.5;
        const tx = x + (bend.bx * 0.9 + lean * 0.5) * hgt;
        const tz = z + bend.bz * 0.9 * hgt;
        cam.toCam(tx, y + hgt, tz, tc);
        if (tc[2] < 0.2) continue;
        const sT = cam.f / tc[2];
        const dxs = cam.px + tc[0] * sT - bxs;
        const dys = cam.py - tc[1] * sT - bys;
        const L = Math.hypot(dxs, dys);
        const pick = hashf(V.seed + 5, ix, iz, 7);
        const code = L < cellH * 0.55 ? (pick < 0.4 ? 39 : pick < 0.75 ? 44 : 96) : stemChar(dxs, dys); // ' , `
        const c = strokeLight(V, V.colors.blades[Math.floor(pick * V.colors.blades.length * 0.999)], bDepth, y, 0.12);
        S.add(bxs + dxs * 0.5, bys + dys * 0.5, bDepth, code, c, 0.7);
        stats.blades++;
      }
  }

  // --- falling petals (analytic, world-anchored)
  const nP = Math.round(70 * P.petals);
  for (let i = 0; i < nP; i++) {
    const hx = hashf(V.seed + 9, i, 1);
    const hz = hashf(V.seed + 9, i, 2);
    const speed = 0.35 + 0.4 * hashf(V.seed + 9, i, 3);
    const span = 5;
    const fall = (hashf(V.seed + 9, i, 4) * span + V.t * speed) % span;
    const yRel = span - fall;
    const drift = V.t * 0.6 + Math.sin(V.t * 1.3 + i) * 0.4;
    const x = cx - 14 + ((hx * 28 + drift) % 28 + 28) % 28;
    const z = cz + 2 + hz * 26;
    const y = heightAt(T, x, z) + yRel * 0.9;
    cam.toCam(x, y, z, tc);
    if (tc[2] < 0.4) continue;
    const s = cam.f / tc[2];
    const xs = cam.px + tc[0] * s;
    const ys = cam.py - tc[1] * s;
    if (xs < 0 || xs > cam.vw || ys < 0 || ys > cam.vh) continue;
    const c = strokeLight(V, V.colors.flowers[i % V.colors.flowers.length], tc[2], y, 0.2);
    S.add(xs, ys, tc[2], Math.sin(V.t * 3 + i) > 0 ? 39 : 44, c, 0.9);
    stats.petals++;
  }
  return stats;
}
