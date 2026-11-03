// Deterministic randomness. Never use Math.random inside the engine.

function mixK(h: number, v: number): number {
  let k = Math.imul(v | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/** 32-bit integer hash of up to 5 integers (stateless, allocation-free). */
export function hash32(a: number, b = 0, c = 0, d = 0, e = 0): number {
  let h = 0x811c9dc5 | 0;
  h = mixK(h, a);
  h = mixK(h, b);
  h = mixK(h, c);
  h = mixK(h, d);
  h = mixK(h, e);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Stateless hash → float in [0,1). */
export function hashf(a: number, b = 0, c = 0, d = 0, e = 0): number {
  return hash32(a, b, c, d, e) / 4294967296;
}

/** Hash a string to a 32-bit integer (for seeds derived from ids). */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded sequential PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
