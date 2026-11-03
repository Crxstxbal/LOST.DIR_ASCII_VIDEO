import { smoothstep } from '../core/math';

/**
 * Adaptive ASCII level of detail for characters.
 *
 * Detail is chosen from the *projected* size of the face measured in rows of the
 * global character grid (not from camera distance): a face 3 rows tall cannot
 * show eyes, one 60 rows tall can show lids and individual hairs. Every feature
 * fades in over a band of sizes, so zooming never pops; the discrete level is
 * only a label for the editor and for tests.
 */
export type LodLevel = 'xws' | 'ws' | 'ms' | 'cu' | 'ecu';

export const LOD_LEVELS: { id: LodLevel; label: string; minRows: number }[] = [
  { id: 'xws', label: 'Plano general extremo', minRows: 0 },
  { id: 'ws', label: 'Plano general', minRows: 2.5 },
  { id: 'ms', label: 'Plano medio', minRows: 10 },
  { id: 'cu', label: 'Primer plano', minRows: 35 },
  { id: 'ecu', label: 'Primerísimo primer plano', minRows: 80 },
];

export interface LodWeights {
  /** Facial relief (nose, sockets, cheekbones) instead of a plain lit oval. */
  relief: number;
  /** Eyes, brows, nostrils, mouth. */
  features: number;
  /** Bangs on the forehead. */
  bangs: number;
  /** Number of locks per simulated strand (1–4, fractional = fading in). */
  locks: number;
  /** Sheen strands, flyaways, fine hairs. */
  fineHair: number;
  /** Cloak fold lines and lit ridges. */
  folds: number;
  /** Frayed hem threads. */
  hem: number;
  /** Silhouette reinforcement for tiny figures (denser body, stronger rim). */
  silhouette: number;
  /** Extreme close-up extras (lash line, lip highlight, fine hair over the mass). */
  ecu: number;
}

export interface CharacterLod {
  /** Projected face height in grid rows. */
  faceRows: number;
  level: LodLevel;
  w: LodWeights;
}

/** Full detail (LOD disabled): what the character looked like before adaptive LOD. */
const FULL: LodWeights = { relief: 1, features: 1, bangs: 1, locks: 4, fineHair: 1, folds: 1, hem: 1, silhouette: 0, ecu: 0 };

export function lodLevel(faceRows: number): LodLevel {
  let lv: LodLevel = 'xws';
  for (const L of LOD_LEVELS) if (faceRows >= L.minRows) lv = L.id;
  return lv;
}

export function computeLod(faceRows: number, auto: boolean): CharacterLod {
  const r = Math.max(0, faceRows);
  const level = lodLevel(r);
  if (!auto) return { faceRows: r, level, w: { ...FULL } };
  return {
    faceRows: r,
    level,
    w: {
      relief: smoothstep(1.2, 3.5, r),
      features: smoothstep(3.5, 8, r),
      bangs: smoothstep(2, 5, r),
      locks: 1 + 3 * smoothstep(3, 30, r),
      fineHair: smoothstep(8, 20, r),
      folds: smoothstep(3, 9, r),
      hem: smoothstep(5, 12, r),
      silhouette: 1 - smoothstep(1.5, 6, r),
      ecu: smoothstep(60, 100, r),
    },
  };
}

/**
 * Temporal smoothing of the projected size (acts as hysteresis for fast zooms
 * and camera moves). Deterministic: it only looks at the same pure functions
 * evaluated a little earlier in time, never at previous frames.
 */
export function smoothedRows(rowsAt: (dt: number) => number | null): number {
  const taps = [
    [0, 4],
    [0.15, 3],
    [0.3, 2],
    [0.45, 1],
  ];
  let acc = 0;
  let wsum = 0;
  for (const [dt, w] of taps) {
    const v = rowsAt(dt);
    if (v === null || !(v > 0)) continue;
    acc += Math.log(v) * w;
    wsum += w;
  }
  return wsum ? Math.exp(acc / wsum) : 0;
}
