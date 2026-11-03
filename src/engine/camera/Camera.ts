import { easeInOut } from '../core/math';
import type { CameraParams, CameraType } from '../project/schema';

export interface Projected {
  x: number;
  y: number;
  /** Pixels per metre at that depth. */
  s: number;
  /** Camera-space depth (m). */
  depth: number;
}

/**
 * 2.5D pinhole camera: translation + pitch + vertical lens shift. No yaw/roll:
 * views that need a different angle on the character use a dedicated drawing.
 */
export class View {
  readonly vw: number;
  readonly vh: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly f: number;
  readonly pitch: number;
  readonly py: number;
  readonly type: CameraType;
  private cp: number;
  private sp: number;

  constructor(o: { vw: number; vh: number; cx: number; cy: number; cz: number; f: number; pitch: number; py: number; type: CameraType }) {
    this.vw = o.vw;
    this.vh = o.vh;
    this.cx = o.cx;
    this.cy = o.cy;
    this.cz = o.cz;
    this.f = o.f;
    this.pitch = o.pitch;
    this.py = o.py;
    this.type = o.type;
    this.cp = Math.cos(o.pitch);
    this.sp = Math.sin(o.pitch);
  }

  /** Camera-space depth of a world point. */
  depthOf(y: number, z: number) {
    return (z - this.cz) * this.cp - (y - this.cy) * this.sp;
  }

  project(x: number, y: number, z: number): Projected | null {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const dz = z - this.cz;
    const zc = dz * this.cp - dy * this.sp;
    if (zc < 0.05) return null;
    const yc = dy * this.cp + dz * this.sp;
    const s = this.f / zc;
    return { x: this.vw / 2 + dx * s, y: this.py - yc * s, s, depth: zc };
  }

  /** Screen y of the horizon line. */
  get horizonY() {
    return this.py - this.f * Math.tan(this.pitch);
  }

  /** World ray for a screen point: direction (not normalised). */
  ray(sx: number, sy: number) {
    const X = (sx - this.vw / 2) / this.f;
    const Y = (this.py - sy) / this.f;
    return { x: X, y: Y * this.cp - this.sp, z: Y * this.sp + this.cp };
  }

  /** Intersect the ground plane (y = h). Returns world x/z and distance, or null for sky. */
  ground(sx: number, sy: number, h = 0) {
    const d = this.ray(sx, sy);
    if (d.y >= -1e-5) return null;
    const lam = (h - this.cy) / d.y;
    if (lam <= 0) return null;
    return { x: this.cx + d.x * lam, z: this.cz + d.z * lam, dist: lam * Math.hypot(d.x, d.y, d.z) };
  }

  /** Elevation angle of the ray through a screen point (rad, + = above horizon). */
  elevation(sx: number, sy: number) {
    const d = this.ray(sx, sy);
    return Math.atan2(d.y, Math.hypot(d.x, d.z));
  }

  /** Angle at which the camera sees a point at height y, depth z (for character foreshortening). */
  viewElevation(y: number, z: number) {
    return Math.atan2(this.cy - y, Math.max(0.1, z - this.cz));
  }
}

export const BASE_FOCAL = 1400;

export interface SubjectTrack {
  /** World position of the subject at time t. */
  pos(t: number): { x: number; z: number };
  /** Height to aim at (m). */
  aimY: number;
}

/** Evaluate the camera for a shot at shot-time t. Pure function. */
export function evalCamera(cam: CameraParams, subject: SubjectTrack | null, t: number, duration: number, vw: number, vh: number): View {
  const e = easeInOut(duration > 0 ? t / duration : 0);
  const start = subject ? subject.pos(0) : { x: 0, z: 0 };
  // lazy follow: average of recent subject positions (inertia without simulation)
  let fx = start.x;
  let fz = start.z;
  if (subject && cam.follow > 0) {
    const lag = 1.1;
    let sx = 0;
    let sz = 0;
    const N = 9;
    let wsum = 0;
    for (let i = 0; i < N; i++) {
      const w = 1 + i;
      const p = subject.pos(Math.max(0, t - lag * (1 - i / (N - 1))));
      sx += p.x * w;
      sz += p.z * w;
      wsum += w;
    }
    fx = start.x + (sx / wsum - start.x) * cam.follow;
    fz = start.z + (sz / wsum - start.z) * cam.follow;
  }
  const zoom = cam.zoom * (1 + (cam.zoomTo - 1) * e);
  const f = BASE_FOCAL * zoom;
  const py = vh * 0.5;
  const hy = cam.horizon * vh;
  const pitch = Math.atan((py - hy) / f);
  let cx = fx + cam.offsetX + cam.moveX * e;
  let cy = cam.height + cam.moveY * e;
  let cz: number;
  // horizontal camera distance measured along the ground to the subject
  cz = fz - cam.distance;
  if (cam.type === 'closeup') {
    cy = cam.height + cam.moveY * e;
  }
  return new View({ vw, vh, cx, cy, cz, f, pitch, py, type: cam.type });
}
