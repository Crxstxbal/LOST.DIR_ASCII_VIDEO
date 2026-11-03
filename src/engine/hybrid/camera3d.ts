import type { Projected, View } from '../camera/Camera';

/**
 * Full 3D pinhole camera for the HYBRID renderer: position + yaw + pitch, focal
 * length in virtual pixels and the same vertical lens shift (py) as the LEGACY
 * `View`. With yaw = 0 it projects exactly like `View` (parity), so both renderers
 * frame the same shot identically; yaw and steep pitch (overhead) are HYBRID-only.
 *
 * Basis (world, y up): pitch > 0 looks down, yaw > 0 turns toward +x.
 */
export class Camera3D {
  readonly vw: number;
  readonly vh: number;
  readonly px: number;
  readonly py: number;
  readonly f: number;
  readonly pos: [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  /** right, up, forward (unit vectors) */
  readonly R: [number, number, number];
  readonly U: [number, number, number];
  readonly F: [number, number, number];

  constructor(o: { vw: number; vh: number; py: number; f: number; pos: [number, number, number]; yaw: number; pitch: number }) {
    this.vw = o.vw;
    this.vh = o.vh;
    this.px = o.vw / 2;
    this.py = o.py;
    this.f = o.f;
    this.pos = o.pos;
    this.yaw = o.yaw;
    this.pitch = o.pitch;
    const cy = Math.cos(o.yaw);
    const sy = Math.sin(o.yaw);
    const cp = Math.cos(o.pitch);
    const sp = Math.sin(o.pitch);
    this.R = [cy, 0, -sy];
    this.U = [sy * sp, cp, cy * sp];
    this.F = [sy * cp, -sp, cy * cp];
  }

  /** From a LEGACY view (yaw 0) plus optional extra aim. */
  static fromView(v: View, aim?: { yaw?: number; pitch?: number }) {
    return new Camera3D({ vw: v.vw, vh: v.vh, py: v.py, f: v.f, pos: [v.cx, v.cy, v.cz], yaw: aim?.yaw ?? 0, pitch: v.pitch + (aim?.pitch ?? 0) });
  }

  /** Camera-space coordinates (x right, y up, z forward). */
  toCam(x: number, y: number, z: number, out: Float64Array | number[]) {
    const dx = x - this.pos[0];
    const dy = y - this.pos[1];
    const dz = z - this.pos[2];
    out[0] = dx * this.R[0] + dy * this.R[1] + dz * this.R[2];
    out[1] = dx * this.U[0] + dy * this.U[1] + dz * this.U[2];
    out[2] = dx * this.F[0] + dy * this.F[1] + dz * this.F[2];
  }

  private tmp = new Float64Array(3);
  project(x: number, y: number, z: number): Projected | null {
    const c = this.tmp;
    this.toCam(x, y, z, c);
    if (c[2] < 0.05) return null;
    const s = this.f / c[2];
    return { x: this.px + c[0] * s, y: this.py - c[1] * s, s, depth: c[2] };
  }

  /** World direction of the ray through a screen point (not normalised; its F component is 1). */
  ray(sx: number, sy: number, out: Float64Array | number[]) {
    const X = (sx - this.px) / this.f;
    const Y = (this.py - sy) / this.f;
    out[0] = this.R[0] * X + this.U[0] * Y + this.F[0];
    out[1] = this.R[1] * X + this.U[1] * Y + this.F[1];
    out[2] = this.R[2] * X + this.U[2] * Y + this.F[2];
  }

  /** Screen y of the horizon (only meaningful for moderate pitch). */
  get horizonY() {
    return this.py - this.f * Math.tan(this.pitch);
  }
}
