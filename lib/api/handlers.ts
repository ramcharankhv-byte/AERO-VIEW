import { NextResponse } from 'next/server';
import {
  backend, getBuildingDetail, getBuildings, getConflicts, getParcels,
  getRoads, getUtilities, queryPoint,
} from '@/lib/db';
import { applyEdit } from '@/lib/data/edits';
import { coerceEdit, validateEdit, warningsFor } from '@/lib/data/building-schema';
import { resolveProject, unavailableMessage } from '@/lib/projects';
import { editsRev } from '@/lib/data/edits';
import { jsonPayload } from '@/lib/http/payload';
import { cachedDetail, warmProject } from '@/lib/server-cache';

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
 */
async function serve<T>(
  slug: string,
  what: string,
  load: (slug: string) => Promise<T>,
  req: Request,
  extra: Record<string, string> = {},
): Promise<NextResponse> {
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const body = await load(slug);
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
  return serve(slug, 'buildings', getBuildings, req);
}

/** GET .../parcels -> GeoJSON of surface parcel polygons. */
export function parcelsRoute(slug: string, req: Request) {
  return serve(slug, 'parcels', getParcels, req);
}

/** GET .../utilities -> utility centrelines with depth/radius/authority. */
export function utilitiesRoute(slug: string, req: Request) {
  return serve(slug, 'utilities', getUtilities, req);
}

/** GET .../conflicts -> utility/basement intersections found by ST_3DIntersects. */
export function conflictsRoute(slug: string, req: Request) {
  return serve(slug, 'conflicts', getConflicts, req);
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
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const detail = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
    }
    return await jsonPayload(req, detail, {
      resource: `${slug}:building:${id}`,
      rev: String(editsRev(slug)),
      headers: await baseHeaders(slug),
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
  const gate = await gateProject(slug);
  if (gate) return gate;
  // The first building-scoped call a session makes, and it does not await the
  // warm-up: the landmarks are pulled in while this response is written.
  warmProject(slug);
  try {
    const detail = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
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
        headers: await baseHeaders(slug),
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
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const detail = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
    }
    return await jsonPayload(req, { building_id: id, floors: detail.floors }, {
      resource: `${slug}:building-floors:${id}`,
      rev: String(editsRev(slug)),
      headers: await baseHeaders(slug),
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

  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const detail = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
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
        headers: await baseHeaders(slug),
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
    const updated = await getBuildingDetail(slug, id);

    return NextResponse.json(
      {
        detail: updated,
        rev: record.rev,
        updated_at: record.updated_at,
        warnings: warningsFor(coerced.value, ctxValues),
      },
      {
        headers: {
          ...(await baseHeaders(slug)),
          'x-ulpin-edit-rev': String(record.rev),
        },
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
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const stack = await queryPoint(slug, lon, lat, z);
    return NextResponse.json(
      { point: { lon, lat, z }, count: stack.length, stack },
      {
        headers: {
          ...(await baseHeaders(slug)),
          // A click is not a cacheable resource.
          'cache-control': 'no-store',
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'query failed', detail: String(err) },
      { status: 500 },
    );
  }
}
