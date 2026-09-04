import { getBuildingDetail, getBuildings } from './db';
import { editsRev } from './data/edits';
import type { BuildingDetail } from './types';

/**
 * Server-side cache for per-building documents.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT
 * ------------------------------------
 * The collections -- buildings, parcels, utilities, roads, conflicts -- are a
 * fixed handful of large responses per project, and they are already memoised
 * twice: as data by lib/db.ts, and as compressed bytes by lib/http/payload.ts.
 * A third copy of the same megabytes would buy nothing.
 *
 * Building detail documents are the opposite shape: thousands of them per
 * project, each a few tens of kilobytes, and which ones get asked for is driven
 * by where users click. That is exactly the access pattern a bounded, TTL'd
 * cache with promotion is for -- and exactly the one an unbounded memo is
 * dangerous for, since a `Map` that never evicts would end up holding every
 * project's entire detail corpus in the server process.
 *
 * EVERY KEY CARRIES THE SLUG. Building ids are only unique WITHIN a project on
 * this branch -- the seeding pipeline restarts them per AOI -- so a cache keyed
 * on the id alone would serve one project's building under another project's
 * URL. That is the single most damaging bug this layer could have, and it is
 * prevented by construction rather than by review: there is no way to reach the
 * cache except through a function that takes a slug first.
 *
 * WHY NOT REDIS, TODAY
 * --------------------
 * Redis earns its keep when a cache has to be SHARED -- several app instances,
 * or a cache that must survive a deploy. This is one Next.js process in front
 * of one PostGIS, and the documents are derived deterministically from that
 * database, so a cross-process cache would add a network hop, a serialisation
 * pass and an operational dependency to save a query that already takes
 * single-digit milliseconds.
 *
 * So the SHAPE is Redis-ready and the backing store is not Redis: the API below
 * is asynchronous throughout and keys are namespaced strings, which is what
 * makes swapping in a client a contained change (see `CacheBackend`). A caller
 * written against a synchronous cache would have to be rewritten to move it
 * off-process, and that rewrite is the expensive part of the migration.
 *
 * WHAT IS DELIBERATELY NOT CACHED HERE
 * ------------------------------------
 * Geometry destined for the map. Footprint rings and unit polygons are big,
 * highly compressible and identical for every user; they belong in HTTP caches
 * and, at real scale, in pre-built tiles -- not in application memory, where
 * they compete with the thing that actually needs it.
 */

/** How long a cached detail document is served before it is re-read. */
const DETAIL_TTL_MS = 5 * 60 * 1000;
/** How many documents to hold, across all projects. ~50 x 35 KB is a few MB. */
const DETAIL_MAX_ENTRIES = 256;

interface Entry<T> {
  value: T;
  /** Epoch milliseconds after which the entry is stale. */
  expires: number;
  /** Revision the entry was built under; a mismatch invalidates immediately. */
  rev: string;
}

/** The seam a Redis adapter would implement. */
export interface CacheBackend {
  get<T>(key: string): Promise<Entry<T> | undefined>;
  set<T>(key: string, entry: Entry<T>): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  size(): number;
}

/**
 * In-process LRU with TTL.
 *
 * A Map preserves insertion order, so "least recently used" is "first key" as
 * long as every read re-inserts. That is the whole implementation, and it is
 * why there is no linked list here.
 */
class MemoryBackend implements CacheBackend {
  private readonly store = new Map<string, Entry<unknown>>();

  constructor(private readonly max: number) {}

  async get<T>(key: string): Promise<Entry<T> | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, hit);
    return hit as Entry<T>;
  }

  async set<T>(key: string, entry: Entry<T>): Promise<void> {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, entry as Entry<unknown>);
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

const backend: CacheBackend = new MemoryBackend(DETAIL_MAX_ENTRIES);

/** Counters, so cache behaviour is observable rather than assumed. */
const stats = { hits: 0, misses: 0, warmed: 0 };

/**
 * Read through the cache.
 *
 * The classic promotion path: hit serves immediately, miss calls the loader and
 * stores the result. `rev` is compared as well as the TTL so an edit is visible
 * at once rather than after five minutes -- a cadastre that shows the user
 * something other than what they just saved is worse than a slow one.
 */
export async function cached<T>(
  key: string,
  rev: string,
  load: () => Promise<T>,
  ttlMs: number = DETAIL_TTL_MS,
): Promise<T> {
  const hit = await backend.get<T>(key);
  if (hit && hit.rev === rev) {
    stats.hits += 1;
    return hit.value;
  }
  stats.misses += 1;
  const value = await load();
  await backend.set(key, { value, expires: Date.now() + ttlMs, rev });
  return value;
}

export function detailKey(slug: string, id: number): string {
  return `detail:${slug}:${id}`;
}

/**
 * A building's detail document, through the cache.
 *
 * This is the only function the route handlers call. PATCH deliberately keeps
 * using the uncached `getBuildingDetail` for its read-back, because it must see
 * what it has just written -- although the revision key would catch that too,
 * since `applyEdit` bumps it.
 */
export async function cachedDetail(
  slug: string,
  id: number,
): Promise<BuildingDetail | null> {
  return cached(
    detailKey(slug, id),
    String(editsRev(slug)),
    () => getBuildingDetail(slug, id),
  );
}

export async function invalidateDetail(slug: string, id: number): Promise<void> {
  await backend.delete(detailKey(slug, id));
}

export function cacheStats(): Readonly<typeof stats> & { entries: number } {
  return { ...stats, entries: backend.size() };
}

// ---------------------------------------------------------------------------
// Cache warming
// ---------------------------------------------------------------------------

/**
 * Buildings worth having in the cache before anyone asks for them.
 *
 * These are the landmarks a demo or a first-time visitor goes to first, so they
 * are the ones where a cold miss is most visible. Matched by NAME rather than
 * by id because ids are assigned by the seeding pipeline and restart per
 * project, whereas the names are attributes of the real buildings -- which also
 * means one list can serve every AOI: a name that is not in a project simply
 * does not match, and warming that project is a no-op rather than an error.
 *
 * Override with ULPIN_HOT_BUILDINGS, comma-separated.
 *
 * WHAT WARMING MAY AND MAY NOT DO. It loads the detail document -- attributes,
 * floors, units. It does not pre-render or pre-tile anything: a popular
 * building is a reason to have its metadata ready, not a reason to hold its
 * mesh in a web server.
 */
export const HOT_BUILDINGS: readonly string[] =
  (process.env.ULPIN_HOT_BUILDINGS
    ?? 'Dutt Island,VMRDA The Deck,VMRDA Office')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Warmed at most once per (project, process). */
const warming = new Map<string, Promise<number>>();

/**
 * Pull this project's landmark buildings into the cache.
 *
 * Fire-and-forget: callers ignore the promise, so a slow or failing warm-up can
 * never delay the request that triggered it. A failure means the first visitor
 * to that building pays the miss, which is what would have happened anyway.
 */
export function warmProject(slug: string): Promise<number> {
  const existing = warming.get(slug);
  if (existing) return existing;

  const run = (async () => {
    try {
      const fc = await getBuildings(slug);
      const byName = new Map<string, number>();
      for (const f of fc.features) {
        const name = f.properties.name;
        if (name) byName.set(name.toLowerCase(), f.properties.id);
      }
      let n = 0;
      for (const wanted of HOT_BUILDINGS) {
        const id = byName.get(wanted.toLowerCase());
        if (id === undefined) continue;
        // Through cachedDetail, not around it: warming must populate the same
        // key a request would read, or it warms nothing.
        // eslint-disable-next-line no-await-in-loop
        await cachedDetail(slug, id);
        n += 1;
      }
      stats.warmed += n;
      return n;
    } catch {
      return 0;
    }
  })();

  warming.set(slug, run);
  return run;
}
