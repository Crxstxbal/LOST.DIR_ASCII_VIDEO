import { fbm1, fbm2, noise2 } from '../core/noise';
import { mix, type RGB } from '../core/color';
import { clamp, smoothstep } from '../core/math';
import type { Camera3D } from './camera3d';
import { KIND_FAR, KIND_TERRAIN, type GBuffer } from './gbuffer';
import { rasterTriangle, type Vtx } from './rasterizer';

export interface TerrainParams {
  /** overall relief amplitude (m) */
  relief: number;
  /** keeps the walking path (z ≈ pathZ) gentle */
  pathZ: number;
  seed: number;
  soil: RGB;
  undergrowth: RGB;
  far: RGB;
}

/** Terrain height (m) at world (x, z). Pure and deterministic. */
export function heightAt(T: TerrainParams, x: number, z: number): number {
  const s = T.seed;
  const broad = fbm2(x * 0.012, z * 0.012, 3, s + 1) * 1.0;
  const mid = fbm2(x * 0.05, z * 0.05, 2, s + 2) * 0.22;
  // irregular hollows and mounds
  const lumps = noise2(x * 0.11 + 3, z * 0.11, s + 3) * 0.08;
  const swell = smoothstep(30, 140, Math.abs(z - T.pathZ)) * fbm2(x * 0.004, z * 0.004, 2, s + 4) * 4;
  const gentle = 0.35 + 0.65 * smoothstep(1.5, 9, Math.abs(z - T.pathZ));
  return T.relief * (broad + mid + lumps) * gentle + swell;
}

/** Undergrowth / clump density 0..1 (also drives where roses grow). */
export function clumpAt(T: TerrainParams, x: number, z: number) {
  return clamp(fbm2(x * 0.045, z * 0.045, 3, T.seed + 9) * 0.9 + 0.5);
}

const vtxPool: Vtx[] = [];
const tmpRay = new Float64Array(3);
const tmpCam = new Float64Array(3);

/**
 * Terrain mesh sampled in screen space: a grid of rays hits a reference plane, the
 * hit is lifted to the real height and re-projected. The mesh is therefore dense near
 * the camera and sparse far away (automatic LOD), whatever the camera angle.
 */
export function drawTerrain(G: GBuffer, cam: Camera3D, T: TerrainParams, step: number, far: number): number {
  const cols = Math.ceil(G.w / step) + 1;
  const rows = Math.ceil(G.h / step) + 1;
  const need = cols * rows;
  while (vtxPool.length < need) vtxPool.push({ x: 0, y: 0, z: -1, r: 0, g: 0, b: 0, nx: 0, ny: 1, nz: 0 });
  const kx = cam.vw / G.w;
  const ky = cam.vh / G.h;
  const e = 0.35;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = vtxPool[j * cols + i];
      v.z = -1;
      cam.ray(Math.min(G.w, i * step) * kx, Math.min(G.h, j * step) * ky, tmpRay);
      if (tmpRay[1] >= -1e-4) continue;
      const lam = (0 - cam.pos[1]) / tmpRay[1];
      if (lam <= 0) continue;
      const wx = cam.pos[0] + tmpRay[0] * lam;
      const wz = cam.pos[2] + tmpRay[2] * lam;
      const dist = Math.hypot(wx - cam.pos[0], wz - cam.pos[2]);
      if (dist > far) continue;
      const wy = heightAt(T, wx, wz);
      cam.toCam(wx, wy, wz, tmpCam);
      if (tmpCam[2] < 0.06) continue;
      const s = cam.f / tmpCam[2];
      v.x = (cam.px + tmpCam[0] * s) / kx;
      v.y = (cam.py - tmpCam[1] * s) / ky;
      v.z = tmpCam[2];
      // normal from the height gradient
      const hx = heightAt(T, wx + e, wz) - heightAt(T, wx - e, wz);
      const hz = heightAt(T, wx, wz + e) - heightAt(T, wx, wz - e);
      const nl = Math.hypot(hx, 2 * e, hz);
      v.nx = -hx / nl;
      v.ny = (2 * e) / nl;
      v.nz = -hz / nl;
      // albedo: dark soil, rose undergrowth in clumps, dry patches
      const cl = clumpAt(T, wx, wz);
      const dry = smoothstep(0.55, 0.9, fbm2(wx * 0.2, wz * 0.2, 2, T.seed + 13) * 0.5 + 0.5);
      const c = mix(mix(T.soil, T.undergrowth, smoothstep(0.35, 0.75, cl)), [T.soil[0] * 1.6, T.soil[1] * 1.3, T.soil[2] * 1.2], dry * 0.5);
      v.r = c[0];
      v.g = c[1];
      v.b = c[2];
    }
  }
  let tris = 0;
  for (let j = 0; j < rows - 1; j++)
    for (let i = 0; i < cols - 1; i++) {
      const a = vtxPool[j * cols + i];
      const b = vtxPool[j * cols + i + 1];
      const c = vtxPool[(j + 1) * cols + i];
      const d = vtxPool[(j + 1) * cols + i + 1];
      if (a.z > 0 && b.z > 0 && c.z > 0) {
        rasterTriangle(G, a, b, c, KIND_TERRAIN);
        tris++;
      }
      if (b.z > 0 && d.z > 0 && c.z > 0) {
        rasterTriangle(G, b, d, c, KIND_TERRAIN);
        tris++;
      }
    }
  return tris;
}

/** Distant ridges as silhouette strips around the camera (horizon depth). */
export function drawRidges(G: GBuffer, cam: Camera3D, T: TerrainParams, layers: { dist: number; height: number }[]): number {
  if (cam.pitch > 1.15) return 0; // looking straight down: no horizon
  const kx = cam.vw / G.w;
  const ky = cam.vh / G.h;
  let tris = 0;
  const N = 96;
  const span = 1.4;
  for (const [li, L] of layers.entries()) {
    let prevTop: Vtx | null = null;
    let prevBot: Vtx | null = null;
    for (let k = 0; k <= N; k++) {
      const a = cam.yaw - span + (2 * span * k) / N;
      const wx = cam.pos[0] + Math.sin(a) * L.dist;
      const wz = cam.pos[2] + Math.cos(a) * L.dist;
      const hTop = L.height * (0.35 + 0.65 * (fbm1(a * 3.1 + li * 7, 3, T.seed + 50 + li) * 0.5 + 0.5));
      const mk = (wy: number): Vtx | null => {
        cam.toCam(wx, wy, wz, tmpCam);
        if (tmpCam[2] < 1) return null;
        const s = cam.f / tmpCam[2];
        const c = mix(T.far, [0, 0, 0], 0.15 * li);
        return { x: (cam.px + tmpCam[0] * s) / kx, y: (cam.py - tmpCam[1] * s) / ky, z: tmpCam[2], r: c[0], g: c[1], b: c[2], nx: -Math.sin(a), ny: 0.3, nz: -Math.cos(a) };
      };
      const top = mk(hTop);
      const bot = mk(-25);
      if (top && bot && prevTop && prevBot) {
        rasterTriangle(G, prevTop, top, prevBot, KIND_FAR);
        rasterTriangle(G, top, bot, prevBot, KIND_FAR);
        tris += 2;
      }
      prevTop = top;
      prevBot = bot;
    }
  }
  return tris;
}
