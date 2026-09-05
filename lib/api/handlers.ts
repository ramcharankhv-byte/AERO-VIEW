import { NextResponse } from 'next/server';
import {
  backend, getBuildingDetail, getBuildings, getParcels,
  getRoads, getUtilities,
} from '@/lib/db';
import { applyEdit } from '@/lib/data/edits';
import { coerceEdit, validateEdit, warningsFor } from '@/lib/data/building-schema';
import { resolveProject, unavailableMessage } from '@/lib/projects';
import { editsRev } from '@/lib/data/edits';
import { jsonPayload } from '@/lib/http/payload';
import { warmProject } from '@/lib/server-cache';
import {
  cachedDetail, cachedConflicts, cachedQueryPoint, type CacheStatus,
} from '@/lib/cache/store';
import {
  callerContext, enforceBuildingAccess, enforceProjectAccess, refuseMutation,
} from '@/lib/auth/access';
import type { GeoFC } from '@/lib/types';

/**
 * The seven cadastre endpoints, written once.
 *
 * Each exists at two URLs -- `/api/p/<slug>/x`, and the unscoped `/api/x`,
 * which is a thin alias resolving to the demo project -- and the two must be
 * byte-identical, because the acceptance scripts drive the unscoped form while
 * the application drives the scoped one. Sharing the body is the only way to
 * make that true by construction rather than by review.
 *
 * THE ERROR CONTRACT lives here too, in gateProject(), ahead of every load, so
 * that no handler can forget it and no unknown slug reaches a data function:
 *
 *   404  nothing knows this slug -- not the registry, not PostGIS, and there
 *        is no data/api/<slug>/ directory
 *   503  the project is real, but it has no exported snapshot and the database
 *        is not answering. Distinct from 404 deliberately: telling a user
 *        their project does not exist when their docker is merely stopped is
 *        the wrong answer, and the gallery renders the two as different
 *        states rather than as one dead card.
 *
 * Neither path throws. A load that fails after the gate is a 500 carrying the
 * underlying error, which is the pre-existing behaviour of all seven routes.
 */

/** Headers every cadastre response carries. */
async function baseHeaders(slug: string): Promise<Record<string, string>> {
  return {
    'x-ulpin-backend': await backend(slug),
    'x-ulpin-project': slug,
  };
}

/**
 * Add the `x-ulpin-cache: hit|miss|bypass` header to a header bag.
 *
 * The brief is explicit: "Add one additive header, leaving x-ulpin-backend
 * and x-ulpin-roads untouched in name, value and conditions." So this is
 * the ONLY place the new header is composed, and the existing two are
 * never re-stamped by it -- they are owned by baseHeaders() and the
 * roads handler, respectively.
 */
function withCacheHeader(
  headers: Record<string, string>,
  status: CacheStatus,
): Record<string, string> {
  return { ...headers, 'x-ulpin-cache': status };
}

/** The 404/503 gate. Returns null when the project may be served. */
async function gateProject(slug: string): Promise<NextResponse | null> {
  const resolution = await resolveProject(slug);
  if (resolution.kind === 'not-found') {
    return NextResponse.json(
      {
        error: 'project not found',
        slug,
        detail:
          `No project is registered under the slug "${slug}", there is no `
          + `data/api/${slug}/ snapshot directory, and PostGIS has no rows for `
          + 'it. GET /api/projects lists the projects that do exist.',
      },
      { status: 404 },
    );
  }
  if (resolution.kind === 'unavailable') {
    return NextResponse.json(
      {
        error: 'project unavailable',
        slug,
        status: resolution.project.status,
        detail: unavailableMessage(resolution.project),
      },
      { status: 503 },
    );
  }
  return null;
}

/**
 * Load a collection and return it compressed, cacheable and revalidatable.
 *
 * WHY THE REQUEST IS THREADED THROUGH. `NextResponse.json()` streams the body
 * chunked with no `Content-Encoding`, so these five endpoints were shipping raw
 * GeoJSON -- measured at 4.4 MB across one cold boot, and 2.9 s of it (see
 * docs/perf/findings.md). Choosing an encoding needs the client's
 * `Accept-Encoding`, so `serve` needs the Request; every route wrapper now
 * passes the one it already receives.
 *
 * The cache key carries the SLUG. Two projects answer the same handler with
 * different bytes, so a key of "buildings" alone would let one project's
 * cadastre be served under another's URL -- the single most damaging bug this
 * layer could have. It carries the project's edit revision for the same
 * reason lib/http/payload.ts documents: a save must be visible immediately,
 * and `editsRev` is already per-slug on this branch.
 *
 * ROLE FILTER. For a citizen, the collection is replaced with a one-feature
 * FeatureCollection (or empty array) containing only their own building /
 * parcel / utility / conflict. The full FeatureCollection shape is preserved
 * so the rendering layer does not need a "if citizen" branch -- it just gets
 * a small collection and behaves normally.
 */
async function serve<T extends GeoFC>(
  slug: string,
  what: string,
  load: (slug: string) => Promise<T>,
  req: Request,
  extra: Record<string, string> = {},
  filter?: (value: T, ctx: { kind: 'citizen'; buildingId: number; slug: string }) => T | Promise<T>,
): Promise<NextResponse> {
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const raw: T = await load(slug);
    const body: T = ctx.kind === 'citizen' && filter
      ? await filter(raw, { kind: 'citizen', buildingId: ctx.buildingId, slug: ctx.slug })
      : raw;
    return await jsonPayload(req, body, {
      resource: `${slug}:${what}`,
      rev: String(editsRev(slug)),
      headers: { ...(await baseHeaders(slug)), ...extra },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `failed to load ${what}`, detail: String(err) },
      { status: 500 },
    );
  }
}

/** GET .../buildings -> GeoJSON FeatureCollection of every footprint. */
export function buildingsRoute(slug: string, req: Request) {
  return serve(slug, 'buildings', getBuildings, req, {}, filterBuildingsForCitizen);
}

/** Citizen view: only the one building they own. */
function filterBuildingsForCitizen(
  value: GeoFC,
  ctx: { kind: 'citizen'; buildingId: number; slug: string },
): GeoFC {
  const features = Array.isArray(value.features) ? value.features : [];
  return {
    ...value,
    features: features.filter((f) => {
      const id = (f.properties as { id?: number } | null)?.id;
      return id === ctx.buildingId;
    }),
  };
}

/** GET .../parcels -> GeoJSON of surface parcel polygons. */
export function parcelsRoute(slug: string, req: Request) {
  return serve(slug, 'parcels', getParcels, req, {}, filterParcelsForCitizen);
}

/** Citizen view: only the parcel that contains the citizen's building.
 *  The match is by the building's parcel_id, looked up in the buildings
 *  snapshot -- a single file read that is already on the hot path. */
async function filterParcelsForCitizen(
  value: GeoFC,
  ctx: { kind: 'citizen'; buildingId: number; slug: string },
): Promise<GeoFC> {
  const features = Array.isArray(value.features) ? value.features : [];
  // Look up the building's parcel_id. The buildings file is already on the
  // hot path; one more read inside a citizen filter is fine.
  const buildings = await getBuildings(ctx.slug);
  const bFeature = buildings.features.find(
    (b) => (b.properties as { id?: number })?.id === ctx.buildingId,
  );
  const parcelId = (bFeature?.properties as { parcel_id?: number } | null)?.parcel_id;
  if (parcelId === undefined) {
    return { ...value, features: [] };
  }
  return {
    ...value,
    features: features.filter((f) => {
      const id = (f.properties as { id?: number } | null)?.id;
      return id === parcelId;
    }),
  };
}

/** GET .../utilities -> utility centrelines with depth/radius/authority. */
export function utilitiesRoute(slug: string, req: Request) {
  return serve(slug, 'utilities', getUtilities, req, {}, filterUtilitiesForCitizen);
}

/** Citizen view: only utilities tagged with the citizen's building.
 *  City-wide mains (metro, power trunks) are suppressed -- they cross
 *  the AOI but are not what a citizen's screen is for. The demo
 *  building's own risers and laterals come from the building detail
 *  document, not from this endpoint, so a citizen does not lose
 *  anything they should see. */
function filterUtilitiesForCitizen(
  value: GeoFC,
  ctx: { kind: 'citizen'; buildingId: number; slug: string },
): GeoFC {
  const features = Array.isArray(value.features) ? value.features : [];
  return {
    ...value,
    features: features.filter((f) => {
      const pid = (f.properties as { building_id?: number } | null)?.building_id;
      return typeof pid === 'number' && pid === ctx.buildingId;
    }),
  };
}

/** GET .../conflicts -> utility/basement intersections found by ST_3DIntersects. */
export async function conflictsRoute(slug: string, req: Request) {
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const { value, cache } = await cachedConflicts(slug);
    const filtered = ctx.kind === 'citizen'
      ? (Array.isArray(value) ? value.filter((c) => c?.building_id === ctx.buildingId) : [])
      : value;
    return await jsonPayload(req, filtered, {
      resource: `${slug}:conflicts`,
      rev: String(editsRev(slug)),
      headers: withCacheHeader(await baseHeaders(slug), cache),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load conflicts', detail: String(err) },
      { status: 500 },
    );
  }
}

/**
 * GET .../roads -> merged street centrelines.
 *
 * `x-ulpin-roads: derived` is sent alongside the usual backend header because
 * this resource is unlike the others: there is no road table in PostGIS, so it
 * is served from the committed artefact whatever the database is doing. The
 * header says so on the wire rather than only in a comment.
 */
export function roadsRoute(slug: string, req: Request) {
  return serve(slug, 'roads', getRoads, req, { 'x-ulpin-roads': 'derived' });
}

/** Shared id parsing, so GET and PATCH cannot disagree about what is valid. */
function parseEntityId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) ? n : null;
}

/** GET .../building/:id -> building with its floors and units nested. */
export async function buildingDetailRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const ctx = await callerContext(req);
  const denied = enforceBuildingAccess(ctx, slug, id);
  if (denied) return denied;
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const { value: detail, cache } = await cachedDetail(slug, id);
    if (!detail) {
      // A null result here is either "not found" (genuine 404) or "the
      // project was unknown" (handled by the gate above). A genuine 404
      // is NOT cached -- the pristine store skips the write when the
      // underlying getter returns null, and the route does not serve
      // a header that would tell an operator a building exists when it
      // does not. bypass is the honest label: the value is correct, it
      // just never went near Redis.
      return NextResponse.json(
        { error: 'building not found' },
        { status: 404, headers: withCacheHeader(await baseHeaders(slug), cache) },
      );
    }
    return await jsonPayload(req, detail, {
      resource: `${slug}:building:${id}`,
      rev: String(editsRev(slug)),
      headers: withCacheHeader(await baseHeaders(slug), cache),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load building', detail: String(err) },
      { status: 500 },
    );
  }
}

/**
 * The progressive half of the detail API.
 *
 * `/building/:id` returns the whole document -- attributes, parcel, every
 * storey and every flat. That is the right answer for a caller that wants one
 * round trip, and the wrong one for a panel that opens on a header: for a tower
 * the floors and units are the overwhelming majority of the bytes and none of
 * them are on screen until the user opens the ladder or the unit grid.
 *
 * All three read through the SAME cache entry as the full document rather than
 * keeping their own. Two caches over one source are two ways to be stale, and
 * the memory they would save is memory lib/server-cache.ts already bounds.
 */
export async function buildingSummaryRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const ctx = await callerContext(req);
  const denied = enforceBuildingAccess(ctx, slug, id);
  if (denied) return denied;
  const gate = await gateProject(slug);
  if (gate) return gate;
  // The first building-scoped call a session makes, and it does not await the
  // warm-up: the landmarks are pulled in while this response is written.
  // NOTE: warmProject is the in-process LRU warm-up; the Redis cache has
  // its own first-request behaviour. The two coexist for now; the in-process
  // warm path is documented as redundant in the decisions log.
  //
  // The call is attached to a `.catch` so a warm-up failure becomes a
  // single logged warning rather than an unhandled rejection. Without
  // this, a rejected promise from a corrupt snapshot or a transient
  // I/O error would surface as `UnhandledPromiseRejection` and could
  // be flagged by the Next.js dev server as a worker crash.
  warmProject(slug).catch((err: unknown) => {
    console.warn(
      `[ulpin-api] warmProject(${slug}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  try {
    const { value: detail, cache } = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json(
        { error: 'building not found' },
        { status: 404, headers: withCacheHeader(await baseHeaders(slug), cache) },
      );
    }
    return await jsonPayload(
      req,
      {
        building: detail.building,
        parcel: detail.parcel,
        floor_count: detail.floors.length,
        unit_count: detail.units.length,
      },
      {
        resource: `${slug}:building-summary:${id}`,
        rev: String(editsRev(slug)),
        headers: withCacheHeader(await baseHeaders(slug), cache),
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load building', detail: String(err) },
      { status: 500 },
    );
  }
}

export async function buildingFloorsRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const ctx = await callerContext(req);
  const denied = enforceBuildingAccess(ctx, slug, id);
  if (denied) return denied;
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const { value: detail, cache } = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json(
        { error: 'building not found' },
        { status: 404, headers: withCacheHeader(await baseHeaders(slug), cache) },
      );
    }
    return await jsonPayload(req, { building_id: id, floors: detail.floors }, {
      resource: `${slug}:building-floors:${id}`,
      rev: String(editsRev(slug)),
      headers: withCacheHeader(await baseHeaders(slug), cache),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load floors', detail: String(err) },
      { status: 500 },
    );
  }
}

/** Page size when the caller does not ask, and the ceiling when it does. */
const UNITS_DEFAULT_LIMIT = 200;
const UNITS_MAX_LIMIT = 1000;

/**
 * GET .../building/:id/units?level=&limit=&offset=
 *
 * The isolated-floor view wants one storey; an export wants pages. The cap is
 * on the SERVER: an endpoint whose page size is whatever the client asked for
 * is not paginated, it is merely inconvenient.
 */
export async function buildingUnitsRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const url = new URL(req.url);
  const rawLevel = url.searchParams.get('level');
  const level = rawLevel === null ? null : Number(rawLevel);
  if (rawLevel !== null && !Number.isInteger(level)) {
    return NextResponse.json({ error: 'level must be an integer' }, { status: 400 });
  }
  const rawLimit = Number(url.searchParams.get('limit'));
  const rawOffset = Number(url.searchParams.get('offset'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), UNITS_MAX_LIMIT)
    : UNITS_DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const ctx = await callerContext(req);
  const denied = enforceBuildingAccess(ctx, slug, id);
  if (denied) return denied;
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const { value: detail, cache } = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json(
        { error: 'building not found' },
        { status: 404, headers: withCacheHeader(await baseHeaders(slug), cache) },
      );
    }
    const matching = level === null
      ? detail.units
      : detail.units.filter((u) => u.level_no === level);
    return await jsonPayload(
      req,
      {
        building_id: id,
        level,
        total: matching.length,
        offset,
        limit,
        units: matching.slice(offset, offset + limit),
      },
      {
        // The page is part of the identity of the response: two pages of the
        // same building are different resources and must not share an ETag.
        resource: `${slug}:building-units:${id}:${level ?? 'all'}:${offset}:${limit}`,
        rev: String(editsRev(slug)),
        headers: withCacheHeader(await baseHeaders(slug), cache),
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load units', detail: String(err) },
      { status: 500 },
    );
  }
}

/**
 * PATCH .../building/:id -> record a manual edit and return the new document.
 *
 * The response body is the FULL re-read BuildingDetail rather than an
 * acknowledgement, so the client replaces its cached document with a
 * server-authoritative one in a single write and can never drift from what
 * the next reader would see.
 *
 * Status codes carry meaning the form relies on:
 *   400  the body was malformed, or named a field that is not editable
 *        (coordinates and ULPIN land here)
 *   404  no such building
 *   422  well-formed but invalid -- the per-field errors render in the form
 *
 * Edits are stored per project (data/projects/<slug>/edits.json), because the
 * store is keyed by building id and building ids are only unique within a
 * project. One global file would have let a save against one AOI silently
 * rewrite a building in another.
 */
export async function buildingPatchRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be valid JSON' }, { status: 400 });
  }

  const ctx = await callerContext(req);
  const mutationRefused = refuseMutation(ctx);
  if (mutationRefused) return mutationRefused;
  const buildingRefused = enforceBuildingAccess(ctx, slug, id);
  if (buildingRefused) return buildingRefused;

  const coerced = coerceEdit(body);
  if (!coerced.ok) {
    return NextResponse.json(
      { error: 'unrecognised or mistyped fields', errors: coerced.errors },
      { status: 400 },
    );
  }

  const gate = await gateProject(slug);
  if (gate) return gate;

  try {
    const current = await getBuildingDetail(slug, id);
    if (!current) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
    }

    // Validated against the CURRENT values, so a rule spanning two fields
    // still holds when only one of them is in the patch.
    const ctxValues = {
      floors: current.building.floors,
      height_m: current.building.height_m,
    };
    const errors = validateEdit(coerced.value, ctxValues);
    if (errors.length) {
      return NextResponse.json({ error: 'validation failed', errors }, { status: 422 });
    }

    const record = await applyEdit(slug, id, coerced.value);
    // The read-back goes through the same cache as a GET would, with the
    // new edit visible on the very next request. The cache key is the
    // PRISTINE document, not the edited one; the overlay applies the
    // edit on top. This is the "no invalidation to get wrong" property:
    // a PATCH never touches Redis, and the response body is exactly
    // what the next GET would have returned.
    const { value: updated, cache } = await cachedDetail(slug, id);
    if (!updated) {
      return NextResponse.json({ error: 'building vanished' }, { status: 500 });
    }

    return NextResponse.json(
      {
        detail: updated,
        rev: record.rev,
        updated_at: record.updated_at,
        warnings: warningsFor(coerced.value, ctxValues),
      },
      {
        headers: withCacheHeader(
          { ...(await baseHeaders(slug)), 'x-ulpin-edit-rev': String(record.rev) },
          cache,
        ),
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to save building', detail: String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST .../query {lon, lat, z}
 * Every entity whose 3D volume contains the point, ordered
 * parcel < building < floor < unit.
 */
export async function queryRoute(slug: string, req: Request): Promise<NextResponse> {
  let body: { lon?: unknown; lat?: unknown; z?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const lon = Number(body.lon);
  const lat = Number(body.lat);
  const z = Number(body.z);
  if (![lon, lat, z].every(Number.isFinite)) {
    return NextResponse.json(
      { error: 'lon, lat and z are required numbers' },
      { status: 400 },
    );
  }
  if (lat < -90 || lat > 90) {
    return NextResponse.json({ error: 'lat out of range' }, { status: 400 });
  }
  if (lon < -180 || lon > 180) {
    return NextResponse.json({ error: 'lon out of range' }, { status: 400 });
  }

  // NOT through serve(). serve() memoises the compressed body under a
  // per-resource key, and every point query would share the key `slug:query`
  // while answering about a different point -- the cache would hand one user
  // the stack under somebody else's cursor. A point query is also a few
  // hundred bytes about one click: there is nothing here worth compressing or
  // revalidating, so it answers directly.
  //
  // The Redis cache, by contrast, keys each point query by (slug, lon, lat, z)
  // at 7-decimal precision, so distinct clicks land on distinct keys. The
  // CACHE_HIT cost is one map lookup; the CACHE_MISS cost is one ST_3DIntersects
  // run. The TTL is short (60 s) because queries are session-local: a user
  // clicking the same point twice in 60 s gets the same response in 1 ms
  // instead of 30 ms.
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const { value: stack, cache } = await cachedQueryPoint(slug, lon, lat, z);
    // A citizen's clicks should only ever land on their own building; the
    // server still filters the stack so a misclick does not leak neighbours
    // (e.g. a stack entry whose top-level entity is a different building).
    const filtered = ctx.kind === 'citizen'
      ? stack.filter((entry) => {
        const id = (entry as { building_id?: number } | null)?.building_id;
        // Building level entries drop out unless they are the citizen's
        // own building. Parcel / floor / unit entries always belong to
        // a building, and the building is checked above; the absence
        // of building_id on a sub-building entry is therefore a leak
        // (the entry is about some other building) and is dropped.
        return id === ctx.buildingId;
      })
      : stack;
    return NextResponse.json(
      { point: { lon, lat, z }, count: filtered.length, stack: filtered },
      {
        headers: withCacheHeader(
          { ...(await baseHeaders(slug)),
            // A click is not an HTTP-cacheable resource.
            'cache-control': 'no-store',
          },
          cache,
        ),
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'query failed', detail: String(err) },
      { status: 500 },
    );
  }
}
