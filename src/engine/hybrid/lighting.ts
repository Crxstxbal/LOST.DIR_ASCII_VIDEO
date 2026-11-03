import { mix, type RGB } from '../core/color';
import { clamp, smoothstep } from '../core/math';
import { fbm2 } from '../core/noise';
import type { Camera3D } from './camera3d';
import { KIND_FAR, KIND_SKY, KIND_TERRAIN, KIND_VEG, type GBuffer } from './gbuffer';

export interface HybridLight {
  /** direction TOWARD the light (normalised) */
  L: [number, number, number];
  key: RGB;
  keyI: number;
  ambient: RGB;
  ambientI: number;
  rim: number;
  zenith: RGB;
  horizon: RGB;
  glow: RGB;
  clouds: number;
  cloudSpeed: number;
  fog: RGB;
  fogDensity: number;
  fogHeight: number;
  seed: number;
}

export interface ShadowCaster {
  x: number;
  y: number;
  z: number;
  /** shadow length (m) */
  len: number;
  width: number;
}

const ray = new Float64Array(3);

/** Sky colour for a world direction (gradient, low-frequency clouds, glow toward the light). */
export function skyColor(Lt: HybridLight, dx: number, dy: number, dz: number, t: number): RGB {
  const l = Math.hypot(dx, dy, dz) || 1;
  const x = dx / l;
  const y = dy / l;
  const z = dz / l;
  const elev = Math.asin(clamp(y, -1, 1));
  let c = mix(Lt.horizon, Lt.zenith, smoothstep(-0.02, 0.55, elev));
  const g = Math.max(0, x * Lt.L[0] + y * Lt.L[1] + z * Lt.L[2]);
  c = mix(c, Lt.glow, Math.pow(g, 6) * 0.55 + Math.pow(g, 40) * 0.4);
  if (y > 0.015 && Lt.clouds > 0) {
    const k = 260 / y;
    const cx = x * k;
    const cz = z * k;
    const n = fbm2(cx * 0.004 + t * Lt.cloudSpeed * 0.01, cz * 0.004, 4, Lt.seed + 71) * 0.5 + 0.5;
    const cover = smoothstep(1 - Lt.clouds * 0.75, 1.05 - Lt.clouds * 0.45, n);
    const lit = mix(mix(Lt.zenith, [0, 0, 0], 0.3), Lt.glow, Math.pow(g, 3) * 0.7 + 0.08);
    c = mix(c, lit, cover * smoothstep(0.015, 0.12, y) * 0.85);
  }
  return c;
}

/**
 * Deferred lighting of the G-buffer: lambert key + ambient, rim on vegetation, a
 * projected shadow for the character, depth/height fog. Writes lit colour and ink
 * density (luminance-driven, with a contour boost on depth discontinuities so
 * silhouettes and the horizon get edge glyphs).
 */
export function lightGBuffer(G: GBuffer, cam: Camera3D, Lt: HybridLight, t: number, caster: ShadowCaster | null, fx: { fog: number; shadows: number; ambient: number }) {
  const kx = cam.vw / G.w;
  const ky = cam.vh / G.h;
  const L = Lt.L;
  const amb = Lt.ambientI * fx.ambient;
  // shadow direction on the ground (away from the light)
  const sl = Math.hypot(L[0], L[2]) || 1;
  const sdx = -L[0] / sl;
  const sdz = -L[2] / sl;
  // sky at half resolution (smooth), filled into 2×2 blocks
  for (let y = 0; y < G.h; y += 2)
    for (let x = 0; x < G.w; x += 2) {
      let any = false;
      for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) if (y + oy < G.h && x + ox < G.w && G.kind[(y + oy) * G.w + x + ox] === KIND_SKY) any = true;
      if (!any) continue;
      cam.ray((x + 1) * kx, (y + 1) * ky, ray);
      const c = skyColor(Lt, ray[0], ray[1], ray[2], t);
      const lum = c[0] * 0.5 + c[1] * 0.3 + c[2] * 0.2;
      for (let oy = 0; oy < 2; oy++)
        for (let ox = 0; ox < 2; ox++) {
          const X = x + ox;
          const Y = y + oy;
          if (X >= G.w || Y >= G.h) continue;
          const i = Y * G.w + X;
          if (G.kind[i] !== KIND_SKY) continue;
          G.lit[i * 3] = c[0];
          G.lit[i * 3 + 1] = c[1];
          G.lit[i * 3 + 2] = c[2];
          G.dens[i] = 0.04 + 0.55 * Math.pow(clamp(lum * 1.6), 0.9);
        }
    }
  for (let y = 0; y < G.h; y++)
    for (let x = 0; x < G.w; x++) {
      const i = y * G.w + x;
      const kind = G.kind[i];
      if (kind === KIND_SKY) continue;
      const d = G.depth[i];
      cam.ray((x + 0.5) * kx, (y + 0.5) * ky, ray);
      // the ray's forward component is 1, so position = cam + ray * depth
      const wx = cam.pos[0] + ray[0] * d;
      const wy = cam.pos[1] + ray[1] * d;
      const wz = cam.pos[2] + ray[2] * d;
      const i3 = i * 3;
      const nx = G.normal[i3];
      const ny = G.normal[i3 + 1];
      const nz = G.normal[i3 + 2];
      const ndl = nx * L[0] + ny * L[1] + nz * L[2];
      let key = clamp((ndl + 0.15) / 1.15);
      // character's projected shadow + contact darkening
      if (caster && (kind === KIND_TERRAIN || kind === KIND_VEG)) {
        const rx = wx - caster.x;
        const rz = wz - caster.z;
        const u = rx * sdx + rz * sdz;
        const v = Math.abs(rx * -sdz + rz * sdx);
        const w = caster.width * (1 - 0.45 * clamp(u / caster.len));
        const inS = smoothstep(-0.3, -0.05, u) * (1 - smoothstep(caster.len * 0.85, caster.len, u)) * (1 - smoothstep(w * 0.7, w, v)) * (1 - smoothstep(0.5, 1.6, Math.abs(wy - caster.y)));
        const contact = 1 - smoothstep(0.1, 0.45, Math.hypot(rx, rz));
        key *= 1 - fx.shadows * Math.max(inS * 0.85, contact * 0.6);
      }
      const ar = G.albedo[i3];
      const ag = G.albedo[i3 + 1];
      const ab = G.albedo[i3 + 2];
      let r = ar * (Lt.ambient[0] * amb + Lt.key[0] * Lt.keyI * key);
      let g = ag * (Lt.ambient[1] * amb + Lt.key[1] * Lt.keyI * key);
      let b = ab * (Lt.ambient[2] * amb + Lt.key[2] * Lt.keyI * key);
      // rim: vegetation and ridges backlit by a low light
      if (kind === KIND_VEG || kind === KIND_FAR) {
        const back = clamp(-(ray[0] * L[0] + ray[1] * L[1] + ray[2] * L[2]) / Math.hypot(ray[0], ray[1], ray[2]));
        const rim = Lt.rim * Math.pow(back, 3) * 0.6;
        r += Lt.glow[0] * rim;
        g += Lt.glow[1] * rim;
        b += Lt.glow[2] * rim;
      }
      // depth + height fog
      const hk = Math.exp(-Math.max(0, wy) * Lt.fogHeight);
      const fog = clamp((1 - Math.exp(-d * Lt.fogDensity * fx.fog * (0.35 + 0.65 * hk))) * 1.02);
      r += (Lt.fog[0] - r) * fog;
      g += (Lt.fog[1] - g) * fog;
      b += (Lt.fog[2] - b) * fog;
      G.lit[i3] = r;
      G.lit[i3 + 1] = g;
      G.lit[i3 + 2] = b;
      const lum = clamp((r * 0.5 + g * 0.3 + b * 0.2) * 2.2);
      const base = kind === KIND_TERRAIN ? 0.05 + 0.5 * lum : kind === KIND_FAR ? 0.06 + 0.45 * lum : 0.08 + 0.7 * lum;
      G.dens[i] = base * G.ink[i] * (1 - 0.4 * fog) + 0.12 * fog;
    }
  // contour glyphs on depth discontinuities (silhouettes, horizon, ridge lines)
  for (let y = 0; y < G.h - 1; y++)
    for (let x = 0; x < G.w - 1; x++) {
      const i = y * G.w + x;
      const d0 = G.depth[i];
      const d1 = G.depth[i + 1];
      const d2 = G.depth[i + G.w];
      const near = Math.min(d0, d1, d2);
      if (!Number.isFinite(near)) continue;
      const far = Math.max(d0, d1, d2);
      if (far / near > 1.12) {
        const k = near === d0 ? i : near === d1 ? i + 1 : i + G.w;
        G.dens[k] = Math.max(G.dens[k], 0.42);
      }
    }
}
