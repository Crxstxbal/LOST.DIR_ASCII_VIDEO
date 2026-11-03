import { hashf } from '../core/rng';

/**
 * A small 3D head model (metres, head-local: x = character's left→right as seen
 * from the front, y up, z out of the face). It is only used to *place* 2D
 * features and hair consistently for any view angle — the head is still drawn
 * as 2D shapes, never as a 3D mesh.
 */
export type V3 = [number, number, number];

export interface HeadOrient {
  /** Face angle around the vertical axis: 0 = facing camera, +π/2 = facing screen right, ±π = back. */
  yaw: number;
  /** Nod: + = chin up. */
  pitch: number;
  /** Roll in the image plane. */
  tilt: number;
}

export const SKULL = { rx: 0.08, ry: 0.108, rz: 0.096 };

/** Rotate a head-local point into view space (x right, y up, z toward camera). */
export function orient(p: V3, o: HeadOrient): V3 {
  let [x, y, z] = p;
  // pitch around local x
  const cp = Math.cos(o.pitch);
  const sp = Math.sin(o.pitch);
  const y1 = y * cp + z * sp;
  const z1 = z * cp - y * sp;
  y = y1;
  z = z1;
  // yaw around y (positive yaw turns the face toward screen right)
  const cy = Math.cos(o.yaw);
  const sy = Math.sin(o.yaw);
  const x2 = x * cy + z * sy;
  const z2 = -x * sy + z * cy;
  x = x2;
  z = z2;
  // tilt in image plane
  const ct = Math.cos(o.tilt);
  const st = Math.sin(o.tilt);
  return [x * ct - y * st, x * st + y * ct, z];
}

/** Facial landmarks (head-local). */
export const FACE = {
  // midline profile, top → bottom
  midline: [
    [0, 0.085, 0.07],
    [0, 0.055, 0.092],
    [0, 0.022, 0.1],
    [0, 0.0, 0.099],
    [0, -0.028, 0.118],
    [0, -0.04, 0.104],
    [0, -0.052, 0.103],
    [0, -0.06, 0.101],
    [0, -0.072, 0.097],
    [0, -0.092, 0.092],
    [0, -0.112, 0.07],
    [0, -0.118, 0.035],
  ] as V3[],
  // side contour (right half, mirrored for left): temple → cheekbone → jaw → chin
  side: [
    [0.075, 0.05, 0.045],
    [0.079, 0.01, 0.04],
    [0.074, -0.03, 0.035],
    [0.064, -0.065, 0.025],
    [0.048, -0.092, 0.035],
    [0.026, -0.11, 0.055],
  ] as V3[],
  eyeL: [-0.034, -0.002, 0.088] as V3,
  eyeR: [0.034, -0.002, 0.088] as V3,
  browL: [-0.036, 0.018, 0.093] as V3,
  browR: [0.036, 0.018, 0.093] as V3,
  noseTip: [0, -0.03, 0.118] as V3,
  noseBase: [0, -0.042, 0.104] as V3,
  mouth: [0, -0.064, 0.098] as V3,
  mouthL: [-0.022, -0.066, 0.09] as V3,
  mouthR: [0.022, -0.066, 0.09] as V3,
  chin: [0, -0.112, 0.07] as V3,
  earL: [-0.08, 0.0, -0.005] as V3,
  earR: [0.08, 0.0, -0.005] as V3,
};

export interface StrandRest {
  /** Rest points (head-local), first = root. */
  pts: V3[];
  kind: 'bang' | 'side' | 'back' | 'crown';
  width: number;
}

/** Irregular, jaw-length black hair: crown strands that flow over the skull then fall. */
export function makeHair(count: number, length: number, seed: number): StrandRest[] {
  const strands: StrandRest[] = [];
  const R = 1.1;
  const N = 7;
  for (let i = 0; i < count; i++) {
    const lon = (i / count) * Math.PI * 2 + (hashf(seed, i, 1) - 0.5) * 0.35; // 0 = front
    const front = Math.cos(lon); // 1 at the face, -1 at the back
    const kind: StrandRest['kind'] = front > 0.55 ? 'bang' : front < -0.4 ? 'back' : 'side';
    const jitter = 0.75 + hashf(seed, i, 2) * 0.5;
    // where the strand leaves the skull surface (latitude) and how far it falls
    const hairlineLat = kind === 'bang' ? 0.36 : kind === 'side' ? -0.05 : -0.55;
    const fallLen = kind === 'bang' ? 0.015 : kind === 'side' ? length * 0.62 * jitter : length * 0.55 * jitter;
    const pts: V3[] = [];
    const crownLat = 1.25;
    // over the skull: lat from crown to hairline
    const surf = (lat: number): V3 => {
      const cl = Math.cos(lat);
      return [Math.sin(lon) * cl * SKULL.rx * R, Math.sin(lat) * SKULL.ry * R, Math.cos(lon) * cl * SKULL.rz * R];
    };
    const nSurf = 4;
    for (let k = 0; k < nSurf; k++) pts.push(surf(crownLat + (hairlineLat - crownLat) * (k / (nSurf - 1))));
    const last = pts[pts.length - 1];
    // side strands fall slightly backward so the face stays visible in profile
    const out: V3 = [Math.sin(lon) * 0.014, 0, kind === 'bang' ? Math.cos(lon) * 0.02 : kind === 'side' ? -0.035 : Math.cos(lon) * 0.008];
    for (let k = 1; k <= N - nSurf; k++) {
      const f = k / (N - nSurf);
      pts.push([last[0] + out[0] * f * 1.5, last[1] - fallLen * f, last[2] + out[2] * f * (kind === 'bang' ? 1.2 : 1)]);
    }
    strands.push({ pts, kind, width: (kind === 'bang' ? 0.016 : 0.022) * (0.8 + hashf(seed, i, 3) * 0.5) });
  }
  // a few loose crown wisps for the irregular silhouette
  for (let i = 0; i < 5; i++) {
    const lon = hashf(seed, i, 11) * Math.PI * 2;
    const pts: V3[] = [];
    for (let k = 0; k < N; k++) {
      const lat = 1.3 - k * 0.12;
      const cl = Math.cos(lat);
      pts.push([Math.sin(lon) * cl * SKULL.rx * 1.18, Math.sin(lat) * SKULL.ry * 1.18 + 0.004 * k, Math.cos(lon) * cl * SKULL.rz * 1.18]);
    }
    strands.push({ pts, kind: 'crown', width: 0.01 });
  }
  return strands;
}
