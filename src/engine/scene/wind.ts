import { noise1, noise2 } from '../core/noise';
import type { WindParams } from '../project/schema';
import type { WindField } from './types';

/** Shared wind field: steady flow + travelling gusts. Pure function of (t, position). */
export function makeWind(w: WindParams, seed: number): WindField {
  const base = w.direction * w.strength * 4.5;
  return (t, x, _y, z) => {
    const g1 = noise1(t * 0.33 - x * 0.035 * w.direction, seed + 101);
    const g2 = noise2(t * 1.1 - x * 0.12 * w.direction, z * 0.08, seed + 202);
    return base * (1 + w.gust * (0.75 * g1 + 0.35 * g2));
  };
}
