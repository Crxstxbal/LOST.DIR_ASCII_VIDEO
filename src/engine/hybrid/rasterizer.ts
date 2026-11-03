import type { GBuffer } from './gbuffer';

/**
 * Software rasteriser into a GBuffer (zone pixels). Depth-tested triangles with
 * perspective-correct attributes (albedo + normal), depth-tested segments and discs.
 * No allocation per primitive.
 */
export interface Vtx {
  x: number;
  y: number;
  /** camera depth */
  z: number;
  r: number;
  g: number;
  b: number;
  nx: number;
  ny: number;
  nz: number;
}

export function rasterTriangle(G: GBuffer, a: Vtx, b: Vtx, c: Vtx, kind: number, ink = 1) {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(G.w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(G.h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  if (minX > maxX || minY > maxY) return;
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-9) return;
  const ia = 1 / area;
  const iza = 1 / a.z;
  const izb = 1 / b.z;
  const izc = 1 / c.z;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) * ia;
      const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) * ia;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const iz = w0 * iza + w1 * izb + w2 * izc;
      const z = 1 / iz;
      const i = y * G.w + x;
      if (z >= G.depth[i]) continue;
      G.depth[i] = z;
      G.kind[i] = kind;
      G.ink[i] = ink;
      // perspective-correct weights
      const p0 = w0 * iza * z;
      const p1 = w1 * izb * z;
      const p2 = 1 - p0 - p1;
      const i3 = i * 3;
      G.albedo[i3] = a.r * p0 + b.r * p1 + c.r * p2;
      G.albedo[i3 + 1] = a.g * p0 + b.g * p1 + c.g * p2;
      G.albedo[i3 + 2] = a.b * p0 + b.b * p1 + c.b * p2;
      G.normal[i3] = a.nx * p0 + b.nx * p1 + c.nx * p2;
      G.normal[i3 + 1] = a.ny * p0 + b.ny * p1 + c.ny * p2;
      G.normal[i3 + 2] = a.nz * p0 + b.nz * p1 + c.nz * p2;
    }
  }
}

/** Depth-tested line segment (≈1 zone pixel wide) with constant colour and normal. */
export function rasterSegment(
  G: GBuffer,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  r: number,
  g: number,
  b: number,
  nx: number,
  ny: number,
  nz: number,
  kind: number,
  ink: number,
  width = 1,
) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  const hw = Math.max(0, (width - 1) / 2);
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    const cx = x0 + dx * f;
    const cy = y0 + dy * f;
    const z = z0 + (z1 - z0) * f;
    for (let oy = -hw; oy <= hw; oy++)
      for (let ox = -hw; ox <= hw; ox++) {
        const x = Math.floor(cx + ox);
        const y = Math.floor(cy + oy);
        if (x < 0 || y < 0 || x >= G.w || y >= G.h) continue;
        const i = y * G.w + x;
        if (z >= G.depth[i]) continue;
        G.depth[i] = z;
        G.kind[i] = kind;
        G.ink[i] = ink;
        const i3 = i * 3;
        G.albedo[i3] = r;
        G.albedo[i3 + 1] = g;
        G.albedo[i3 + 2] = b;
        G.normal[i3] = nx;
        G.normal[i3 + 1] = ny;
        G.normal[i3 + 2] = nz;
      }
  }
}

/** Depth-tested filled ellipse (camera-facing): blooms, foliage clumps. */
export function rasterDisc(
  G: GBuffer,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  z: number,
  r: number,
  g: number,
  b: number,
  nx: number,
  ny: number,
  nz: number,
  kind: number,
  ink: number,
) {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(G.w - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(G.h - 1, Math.ceil(cy + ry));
  const irx = 1 / Math.max(0.5, rx);
  const iry = 1 / Math.max(0.5, ry);
  for (let y = y0; y <= y1; y++) {
    const v = (y + 0.5 - cy) * iry;
    for (let x = x0; x <= x1; x++) {
      const u = (x + 0.5 - cx) * irx;
      const q = u * u + v * v;
      if (q > 1) continue;
      const i = y * G.w + x;
      if (z >= G.depth[i]) continue;
      G.depth[i] = z;
      G.kind[i] = kind;
      G.ink[i] = ink;
      const i3 = i * 3;
      // slight dome shading in the albedo so blooms read as volumes
      const dome = 1 - 0.35 * q;
      G.albedo[i3] = r * dome;
      G.albedo[i3 + 1] = g * dome;
      G.albedo[i3 + 2] = b * dome;
      G.normal[i3] = nx;
      G.normal[i3 + 1] = ny;
      G.normal[i3 + 2] = nz;
    }
  }
}
