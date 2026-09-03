/**
 * Deterministic pseudo-randomness for the synthetic building register.
 *
 * The requirement this exists to meet is stability, not statistical quality:
 * a building must show the same name on every reload, in every browser, after
 * a server restart, and whether the record came from PostGIS or the committed
 * snapshot. `Math.random()` fails all four. xmur3 + mulberry32 are ten lines
 * each, need no dependency, and produce identical output in any JS engine.
 */

/** Hash a string to a 32-bit seed. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** Uniform [0, 1) from a 32-bit seed. */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A generator for one FIELD of one building.
 *
 * The `salt` is what makes each field independent: without it, changing how
 * `status` is chosen would shift every subsequent draw and silently rename
 * every building in the dataset. With it, the two are unrelated streams.
 *
 * Seeded from the building's integer primary key, never from its position in
 * an array -- feature order is not guaranteed stable and every name in the
 * application would move if it changed.
 */
export function rngFor(salt: string, id: number): () => number {
  return mulberry32(xmur3(`ulpin-3d:${salt}:${id}`)());
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function floatBetween(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Weighted choice over [value, weight] pairs. */
export function weighted<T>(rng: () => number, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((t, [, w]) => t + w, 0);
  let r = rng() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return entries[entries.length - 1][0];
}
