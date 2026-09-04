import {
  getPristineBuildingDetail,
  getPristineConflicts,
  getPristineQueryPoint,
  getBuildings,
  enrichBuildingDetail,
} from '../db.ts';
import { allEdits } from '../data/edits.ts';
import type { BuildingEdit } from '../data/building-schema.ts';
import type { BuildingDetail, ConflictRow, StackHit, EnrichedBuilding } from '../types.ts';
import { cacheGet } from './redis.ts';
import { conflictsKey, detailKey, queryKey } from './keys.ts';

/**
 * The Redis-backed read-through cache for the three things the user
 * asked us to cache: per-building detail, the conflict set, and the
 * 3D point query.
 *
 * THE CONTRACT
 * ------------
 * Every function in this module follows the same shape:
 *
 *   1. Compose a cache key that includes slug, backend, version
 *      (lib/cache/keys.ts).
 *   2. Try Redis. A hit returns the PRISTINE value -- the value as
 *      it sits in PostGIS or the snapshot, with no edit overlay.
 *   3. A miss calls the underlying lib/db.ts getter and stores the
 *      PRISTINE result, not the result-with-overlay.
 *   4. The function then applies the edit overlay, so the caller
 *      gets back the same shape it would have got from lib/db.ts
 *      today, and a `cacheStatus` so the route handler can set the
 *      `x-ulpin-cache: hit|miss|bypass` header.
 *
 * This is the "no invalidation to get wrong" property. A PATCH
 * changes the edit record on disk; it never touches Redis. The next
 * read of this function pulls the same cached pristine value and
 * applies the new edit on top, which is the only place the edit
 * ever has to be consulted.
 *
 * BYPASS BEHAVIOUR
 * ----------------
 * If Redis is unreachable, the wrapper in lib/cache/redis.ts logs
 * once and returns undefined from cacheGet. The miss path then runs
 * and the response is marked `bypass` rather than `miss`: the
 * underlying value was computed and served, but it was not stored
 * because the store is down. The caller treats bypass and miss the
 * same way for the response body -- only the header differs.
 *
 * The miss path cannot distinguish "Redis is up but the key is new"
 * from "Redis is down" by GET alone, so we attempt a SET and read
 * the wrapper's `degraded` flag to tell them apart. The
 * distinguishing pass costs one extra round trip on a miss, which
 * is the only time the cost is paid.
 */

/** How long a cached pristine value is served before it is re-read. */
const DETAIL_TTL_MS = 5 * 60 * 1000;
const CONFLICTS_TTL_MS = 5 * 60 * 1000;
/** Point queries are cheap to recompute but can fire many per session; a
 *  short TTL keeps the cache useful without making stale results long-lived. */
const QUERY_TTL_MS = 60 * 1000;

export type CacheStatus = 'hit' | 'miss' | 'bypass';

export interface CachedResult<T> {
  value: T;
  cache: CacheStatus;
}

// ---------------------------------------------------------------------------
// Per-building detail
// ---------------------------------------------------------------------------

/**
 * Read a building's detail through the cache.
 *
 * The cached value is the PRISTINE detail (no edit overlay, no
 * enrichment). The overlay runs on every read via
 * `enrichBuildingDetail` -- which is the same enrichment pipeline
 * `getBuildingDetail` uses, lifted out so the cache can hold the
 * PRISTINE byte and re-derive the FINAL byte on every request. A
 * PATCH that changes a building's name or height is visible on the
 * very next request without the PATCH path ever having to invalidate
 * anything in Redis.
 *
 * `null` from the underlying getter is a 404 and is NOT cached: the
 * brief is explicit ("never cache a 404 or 503"), and a stopped
 * container must not poison the cache into claiming a building that
 * exists in the database does not. The bypass label is the honest
 * one: the value is correct, it just never went near Redis.
 */
export async function cachedDetail(
  slug: string,
  id: number,
): Promise<CachedResult<BuildingDetail | null>> {
  const key = await detailKey(slug, id);
  const hit = await readPristine<BuildingDetail | null>(key, DETAIL_TTL_MS, async () => {
    const raw = await getPristineBuildingDetail(slug, id);
    if (raw === null) return { value: null, storeable: false };
    return { value: raw, storeable: true };
  });
  if (hit.value === null) return { value: null, cache: hit.cache };

  // The enrichment is the edit overlay for buildings. It runs on every
  // read against the freshest possible edit record, so the overlay is
  // always consistent with what the panel just saved.
  const final = await enrichBuildingDetail(slug, hit.value);
  return { value: final, cache: hit.cache };
}

// ---------------------------------------------------------------------------
// Conflict set
// ---------------------------------------------------------------------------

/**
 * Read the conflict set through the cache, with the edit overlay.
 *
 * The cached value is the PRISTINE conflict set -- every intersection
 * between utilities and building floors as the database or the
 * snapshot computed it. When a building is edited (height_m or
 * basements), the floor's z range changes, and some pristine
 * conflicts are no longer intersections and some new ones are.
 *
 * The overlay does the cheapest thing that is still correct: it
 * drops every pristine conflict that involves an edited building,
 * because the old intersection might be wrong in either direction.
 * A full re-computation would need the edited floor geometry in
 * PostGIS, which the current edit store does not write -- the
 * PATCH path touches only the building row, not the floor rows.
 * Dropping is the safe answer; a re-seed is the complete one, and
 * the decisions log records the trade.
 */
export async function cachedConflicts(
  slug: string,
): Promise<CachedResult<ConflictRow[]>> {
  const key = await conflictsKey(slug);
  const hit = await readPristine<ConflictRow[]>(key, CONFLICTS_TTL_MS, async () => ({
    value: await getPristineConflicts(slug),
    storeable: true,
  }));
  const edits = await allEdits(slug);
  if (edits.size === 0) return { value: hit.value, cache: hit.cache };
  // The edit record is read from the in-memory rev-keyed map, not
  // from the cache, so the overlay is always consistent with what
  // the panel just saved.
  const value = hit.value.filter((c) => !edits.has(c.building_id));
  return { value, cache: hit.cache };
}

// ---------------------------------------------------------------------------
// 3D point query
// ---------------------------------------------------------------------------

/**
 * Read a point query through the cache, with the edit overlay.
 *
 * The cached value is the PRISTINE stack: every entity whose 3D
 * volume contains (lon, lat, z) as PostGIS or the snapshot
 * computed it, with the building label as it sits in the database
 * (or absent).
 *
 * The overlay adjusts the result for edited buildings:
 *   - A point inside an edited building whose height_m changed
 *     might no longer be inside, or might now be inside; the
 *     overlay re-tests the z value against the edited building's
 *     extruded range and drops the entry if the point fell out.
 *   - A building's name might have been edited; the overlay replaces
 *     the label so the picker names the building the way the panel
 *     will read it.
 *
 * What the overlay does NOT do: re-test the 2D containment of the
 * point against an edited building's footprint, or re-test the
 * containment of a point that was OUTSIDE the pristine building's
 * range but might now be INSIDE the edited range. The footprint is
 * never edited (the form refuses coordinates), so the in-2D test is
 * stable. The "newly inside" case is a known limitation of the
 * overlay pattern; a re-seed restores full accuracy.
 */
export async function cachedQueryPoint(
  slug: string,
  lon: number,
  lat: number,
  z: number,
): Promise<CachedResult<StackHit[]>> {
  const key = await queryKey(slug, lon, lat, z);
  const hit = await readPristine<StackHit[]>(key, QUERY_TTL_MS, async () => ({
    value: await getPristineQueryPoint(slug, lon, lat, z),
    storeable: true,
  }));

  const edits = await allEdits(slug);
  if (edits.size === 0) return { value: hit.value, cache: hit.cache };

  // Read the buildings FC once for the overlay: we need the
  // ground_elev, basements, and name of every edited building that
  // appears in the stack. `getBuildings` returns the enriched
  // FeatureCollection, which already has the name overlay applied
  // -- the height_m overlay is what the cache applies.
  const named = await getBuildings(slug);
  const byId = new Map<number, EnrichedBuilding>();
  for (const f of named.features) byId.set(f.properties.id, f.properties);

  return {
    value: hit.value
      .map((h): StackHit | null => {
        if (h.level !== 'building') return h;
        const edit = edits.get(h.id);
        if (!edit) return h;
        return overlayBuildingHit(h, edit, byId.get(h.id), z);
      })
      .filter((x): x is StackHit => x !== null),
    cache: hit.cache,
  };
}

// ---------------------------------------------------------------------------
// Internal: the per-hit overlay for the point query
// ---------------------------------------------------------------------------

/**
 * Apply the building-edit overlay to one PRISTINE stack hit.
 *
 * The hit is one of three things after the overlay:
 *   - unchanged (no height_m edit, and the new label is the same)
 *   - relabelled (a name edit only)
 *   - z-recomputed AND relabelled (a height_m edit; the z range
 *     widens or narrows but the point is still in it)
 *
 * If the height_m edit pushed the point OUT of the building, the
 * function returns null and the caller drops the entry from the
 * stack.
 */
function overlayBuildingHit(
  pristine: StackHit,
  edit: Partial<BuildingEdit>,
  building: EnrichedBuilding | undefined,
  z: number,
): StackHit | null {
  const f = edit;
  const pristineHeightChanged = f.height_m !== undefined;
  // The hit's pristine label is whatever the SQL (or its JS twin) put there.
  // The overlay replaces it with the building's enriched name (which
  // already has the name-edit applied) or the edit's name if it named
  // the field directly.
  const enrichedName = building?.name ?? null;
  const label = f.name ?? enrichedName ?? pristine.label;

  if (!pristineHeightChanged) {
    // No z change; just update the label if needed.
    return label === pristine.label ? pristine : { ...pristine, label };
  }

  // Height changed: recompute the z range and re-test containment.
  // ground_elev and basements are not editable (the form refuses them
  // and the type system forbids them), so the post-edit range is
  // [ground_elev - basements*3.2, ground_elev + edited_height_m].
  // We need the PRISTINE ground_elev / basements for the bottom of
  // the range; the enriched building is fine for that, since edits
  // never touch those columns.
  const ground = building?.ground_elev ?? 0;
  const basements = building?.basements ?? 0;
  const height = f.height_m ?? 0;
  const zMin = ground - basements * 3.2;
  const zMax = ground + height;
  if (z < zMin || z > zMax) return null; // edited building no longer contains the point
  return { ...pristine, z_min: zMin, z_max: zMax, label };
}

// ---------------------------------------------------------------------------
// Internal: the read-through primitive
// ---------------------------------------------------------------------------

interface PristineRead<T> {
  value: T;
  cache: CacheStatus;
}

/**
 * The read-through primitive every cached function uses.
 *
 * Behaviour:
 *   1. Try Redis. A hit returns `{ value, cache: 'hit' }`.
 *   2. A miss calls the loader. If the loader marks the value
 *      un-storeable (the 404 case), the result is `{ value, cache: 'bypass' }`
 *      and Redis is never touched on the write side either.
 *   3. A miss with a storeable value writes the PRISTINE to Redis
 *      and reports the cache label as 'miss' if the write succeeded
 *      or 'bypass' if it didn't. The wrapper in lib/cache/redis.ts
 *      logs once on failure and never throws, so this call cannot
 *      fail -- the only way it can say "bypass" is if Redis is
 *      currently down.
 *
 * The cache label is the truth about what happened, not a guess: a
 * real miss writes; a bypass does not. The route handler sets the
 * `x-ulpin-cache` header to that label verbatim.
 */
async function readPristine<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<{ value: T; storeable: boolean }>,
): Promise<PristineRead<T>> {
  const cached = await cacheGet<T>(key);
  if (cached !== undefined) return { value: cached, cache: 'hit' };

  const { value, storeable } = await load();
  if (!storeable) return { value, cache: 'bypass' };

  const { cacheSet, isCacheDegraded } = await import('./redis');
  await cacheSet(key, value, ttlMs);
  return { value, cache: isCacheDegraded() ? 'bypass' : 'miss' };
}
