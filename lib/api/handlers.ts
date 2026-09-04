import { NextResponse } from 'next/server';
import {
  backend, getBuildingDetail, getBuildings, getConflicts, getParcels,
  getRoads, getUtilities, queryPoint,
} from '@/lib/db';
import { applyEdit } from '@/lib/data/edits';
import { coerceEdit, validateEdit, warningsFor } from '@/lib/data/building-schema';
import { resolveProject, unavailableMessage } from '@/lib/projects';

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

async function serve<T>(
  slug: string,
  what: string,
  load: (slug: string) => Promise<T>,
  extra: Record<string, string> = {},
): Promise<NextResponse> {
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const body = await load(slug);
    return NextResponse.json(body as object, {
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
export function buildingsRoute(slug: string) {
  return serve(slug, 'buildings', getBuildings);
}

/** GET .../parcels -> GeoJSON of surface parcel polygons. */
export function parcelsRoute(slug: string) {
  return serve(slug, 'parcels', getParcels);
}

/** GET .../utilities -> utility centrelines with depth/radius/authority. */
export function utilitiesRoute(slug: string) {
  return serve(slug, 'utilities', getUtilities);
}

/** GET .../conflicts -> utility/basement intersections found by ST_3DIntersects. */
export function conflictsRoute(slug: string) {
  return serve(slug, 'conflicts', getConflicts);
}

/**
 * GET .../roads -> merged street centrelines.
 *
 * `x-ulpin-roads: derived` is sent alongside the usual backend header because
 * this resource is unlike the others: there is no road table in PostGIS, so it
 * is served from the committed artefact whatever the database is doing. The
 * header says so on the wire rather than only in a comment.
 */
export function roadsRoute(slug: string) {
  return serve(slug, 'roads', getRoads, { 'x-ulpin-roads': 'derived' });
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
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const detail = await getBuildingDetail(slug, id);
    if (!detail) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
    }
    return NextResponse.json(detail, { headers: await baseHeaders(slug) });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load building', detail: String(err) },
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

  return serve(slug, 'query', async (s) => {
    const stack = await queryPoint(s, lon, lat, z);
    return { point: { lon, lat, z }, count: stack.length, stack };
  });
}
