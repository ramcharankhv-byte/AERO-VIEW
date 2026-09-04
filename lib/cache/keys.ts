import { backend } from '../db.ts';

/**
 * Cache key composition.
 *
 * THREE SEGMENTS, IN THIS ORDER
 * -----------------------------
 *   ulpin : <version> : <slug> : <backend> : <resource> : <params>
 *
 * 1. `version` is a global segment the operator bumps to flush every key.
 *    After a re-seed, a re-import, or any change to the serialisation of
 *    a cached value, set `ULPIN_CACHE_VERSION=2` in the environment and
 *    every old key is unreachable: a miss is cheap, and a write under the
 *    new key happens on the next request. Bumping is the flush, so the
 *    cache has no SCAN/DEL maintenance path to forget.
 *
 * 2. `slug` keeps one project's data out of another's URL. Building ids
 *    restart per AOI, so a key that omitted the slug would happily serve
 *    siripuram's building 1 to a request for hyderabad-banjara's building
 *    1 if the two shared a hot path.
 *
 * 3. `backend` is the answer `scopeFor` gave at the time of the read --
 *    `postgis` when the database answered, `snapshot` when the committed
 *    file answered. The brief is explicit: "a snapshot-served payload
 *    must never come back labelled postgis". Including the backend in the
 *    key is what enforces that -- a payload cached under `postgis` cannot
 *    be served to a request that resolves to `snapshot` and vice versa.
 *
 * PARAMS IS RESOURCE-SPECIFIC
 * ---------------------------
 * `detail` keys end with the building id; `query` keys end with the
 * lon,lat,z coordinates at fixed precision; `conflicts` keys have no
 * params segment at all. Centralising the composition here means every
 * call site uses the same separator and the same precision, so two
 * callers writing the "same" key cannot accidentally produce two keys.
 */

const VERSION = process.env.ULPIN_CACHE_VERSION ?? '1';

/** Separator: `:` is the Redis convention and the only one that won't be
 *  mangled by either Next's URL path or by the JSON we serialise as value. */
const SEP = ':';
const PREFIX = 'ulpin';

/**
 * Resolve the current backend for a slug and compose the prefix that
 * every key for that slug starts with. Reads `scopeFor` (via `backend`)
 * on every call so a flip from snapshot to postgis or back is reflected
 * in the key the next request writes -- the cache follows the backend,
 * not the other way around.
 */
async function scopedPrefix(slug: string): Promise<string> {
  const be = await backend(slug);
  return [PREFIX, VERSION, slug, be].join(SEP);
}

/** Detail key: one per building per (slug, backend, version). */
export async function detailKey(slug: string, id: number): Promise<string> {
  return `${await scopedPrefix(slug)}:detail:${id}`;
}

/**
 * Conflict set key: one per (slug, backend, version). The set has no
 * parameters -- a conflict set is a property of the project, not of a
 * click or a coordinate.
 */
export async function conflictsKey(slug: string): Promise<string> {
  return `${await scopedPrefix(slug)}:conflicts`;
}

/**
 * Point query key: one per (slug, backend, version, lon, lat, z). The
 * three coordinates are formatted to 7 decimals so a click at the same
 * point produces the same key regardless of the JS number's binary
 * representation -- the same precision rule lib/http/payload.ts applies
 * to coordinates on the wire.
 */
export async function queryKey(
  slug: string,
  lon: number,
  lat: number,
  z: number,
): Promise<string> {
  const fmt = (n: number) => n.toFixed(7);
  return `${await scopedPrefix(slug)}:query:${fmt(lon)},${fmt(lat)},${fmt(z)}`;
}

/** The prefix the version-bump flush walks. */
export function cachePrefix(): string {
  return `${PREFIX}${SEP}`;
}

/** The current version, for diagnostics. */
export function cacheVersion(): string {
  return VERSION;
}
