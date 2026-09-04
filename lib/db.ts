import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type {
  BuildingDetail, BuildingProps, ConflictRow, EnrichedBuilding, GeoFC,
  ParcelInfo, Project, ProjectStats, RoadProps, StackHit, UtilityProps,
} from './types';
import { enrichBuilding, enrichCollection, type UnitFacts } from './mock/building';
import { allEdits, editsFor, editsRev } from './data/edits';
import type { BuildingEdit } from './data/building-schema';
import { API_DIR, DEFAULT_SLUG, isValidSlug } from './projects';

/**
 * Data access with two backends, scoped by project.
 *
 * PostGIS is the source of truth and does the real spatial work (ST_3DIntersects
 * over PolyhedralSurface solids). When it is unreachable -- typically because
 * docker-compose is not running -- we serve the committed snapshots in
 * data/api/<slug>/, which scripts/05_export_static.py generated FROM that same
 * database. The snapshot is never an alternative implementation of the spatial
 * logic; it is a cache of its output, so the two cannot drift in behaviour.
 *
 * The one genuine difference is /api/query: the point-in-volume test runs in
 * SQL when the DB is up, and as an equivalent prism test in JS when it is not.
 * Both are exact for vertical prisms, which is all this schema stores.
 *
 * SCOPING. Every exported reader takes a slug first. On the snapshot path that
 * selects a directory; on the PostGIS path it selects a `projects.id` that is
 * pushed into the WHERE clause. Three cases, resolved once per slug by
 * scopeFor():
 *
 *   scoped   the projects table exists and knows this slug -> filter on
 *            project_id, which is the normal multi-project case
 *   legacy   the projects table does NOT exist (a pre-migration volume) and
 *            the slug is the demo project -- every row in such a database is
 *            siripuram, so the unfiltered query is the correct one
 *   none     neither -- there is no PostGIS answer for this project, and the
 *            snapshot serves. This is also what a database that is simply not
 *            running looks like.
 *
 * `legacy` is what lets an existing ulpin_pgdata volume keep working without
 * running db/migrations/001_multi_project.sql first, rather than silently
 * falling back to the snapshot while the header still claimed `postgis`.
 */

const CONNECT_TIMEOUT_MS = 1500;

let pool: Pool | null = null;
let dbUsable: boolean | null = null; // null = not yet probed

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? 'postgresql://ulpin:ulpin@localhost:55432/ulpin',
      max: 10,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 10000,
    });
    // A pool-level error must not take the process down.
    pool.on('error', () => {
      dbUsable = false;
    });
  }
  return pool;
}

/** Probe once per process. */
async function usingDb(): Promise<boolean> {
  if (dbUsable !== null) return dbUsable;
  try {
    const res = await getPool().query('SELECT count(*)::int AS n FROM building');
    dbUsable = res.rows[0].n > 0;
  } catch {
    dbUsable = false;
  }
  return dbUsable;
}

async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(sql, params as never[]);
  return res.rows as T[];
}

// ---------------------------------------------------------------------------
// Project scope
// ---------------------------------------------------------------------------

interface Scope {
  /** projects.id, or null in `legacy` mode where the column does not exist. */
  id: number | null;
  /** The AOI name that goes in the FeatureCollection's `aoi` field. */
  name: string;
}

/**
 * Memoised per slug for the life of the process.
 *
 * The pipeline runs as a separate process and the dev server reloads its
 * modules when files change, so a stale entry cannot outlive a re-seed in
 * practice. A long-lived production server that gained a project would need a
 * restart, which is the same contract the snapshot file cache below has always
 * had.
 */
const scopeCache = new Map<string, Scope | null>();

async function scopeFor(slug: string): Promise<Scope | null> {
  if (scopeCache.has(slug)) return scopeCache.get(slug)!;
  const resolved = await resolveScope(slug);
  scopeCache.set(slug, resolved);
  return resolved;
}

async function resolveScope(slug: string): Promise<Scope | null> {
  if (!isValidSlug(slug)) return null;
  if (!(await usingDb())) return null;
  try {
    const rows = await q<{ id: number; name: string }>(
      'SELECT id, name FROM projects WHERE slug = $1', [slug]);
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].name };
  } catch {
    // No projects table: a volume seeded before this feature existed. Every
    // row in it is the demo AOI, so the unfiltered queries are correct for
    // that slug and only that slug.
    return slug === DEFAULT_SLUG
      ? { id: null, name: 'Siripuram, Visakhapatnam' }
      : null;
  }
}

/**
 * Run a PostGIS query for a project, or report that the snapshot should serve.
 *
 * A failed QUERY is treated exactly like a failed probe. The pool is small and
 * deliberately short-timeouted so a missing database is detected fast, which
 * also means a burst of concurrent requests can exhaust it and time out while
 * Postgres is perfectly healthy. The documented contract is that the committed
 * snapshot serves whenever PostGIS cannot -- not that the request 500s -- so a
 * starved pool degrades to the snapshot rather than to an error.
 *
 * The result is wrapped rather than returned as `T | null` because
 * getBuildingDetail legitimately resolves to null for an unknown id, and that
 * must not be confused with "the database could not answer".
 */
async function viaDb<T>(
  slug: string,
  run: (scope: Scope) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const scope = await scopeFor(slug);
  if (!scope) return { ok: false };
  try {
    return { ok: true, value: await run(scope) };
  } catch {
    return { ok: false };
  }
}

/**
 * The project filter, as a SQL fragment plus the parameters that precede it.
 *
 * Returned together so a call site cannot get the placeholder number and the
 * parameter array out of step, which is the one way this could go wrong
 * quietly: a mismatched $n does not error, it filters on the wrong value.
 */
function filter(scope: Scope, expr: string, priorParams: unknown[] = []): {
  clause: string;
  params: unknown[];
} {
  if (scope.id === null) return { clause: '', params: priorParams };
  return {
    clause: expr.replace('$P', `$${priorParams.length + 1}`),
    params: [...priorParams, scope.id],
  };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

const fileCache = new Map<string, unknown>();

/**
 * Read data/api/<slug>/<name>, cached for the life of the process.
 *
 * The slug is validated by isValidSlug() before it is joined onto a directory
 * path, so a crafted slug cannot walk out of data/api/. resolveProject() gates
 * every route ahead of this, but this is the function that actually touches
 * the filesystem and it does not rely on a caller having checked.
 */
async function snapshot<T>(slug: string, name: string): Promise<T> {
  if (!isValidSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  const key = `${slug}/${name}`;
  if (fileCache.has(key)) return fileCache.get(key) as T;
  const raw = await fs.readFile(path.join(API_DIR, slug, name), 'utf-8');
  const parsed = JSON.parse(raw);
  fileCache.set(key, parsed);
  return parsed as T;
}

/**
 * Which backend actually answered for this project.
 *
 * Asking per project rather than globally, because the two can disagree: with
 * PostGIS up and a second project that exists only as a snapshot, a global
 * probe would report `postgis` for a response the snapshot served. For the
 * demo project with the database running this still returns `postgis`, which
 * is what it has always returned and what the acceptance scripts assert.
 */
export async function backend(slug: string): Promise<'postgis' | 'snapshot'> {
  return (await scopeFor(slug)) ? 'postgis' : 'snapshot';
}

// ---------------------------------------------------------------------------
// The registry, read from PostGIS. lib/projects.ts owns the snapshot half.
// ---------------------------------------------------------------------------

const PROJECTS_SQL = `
  SELECT p.slug, p.name, p.state_code, p.district_code, p.scheme_code,
         p.status, p.created_at, p.stats,
         ST_XMin(p.bbox_geom) AS west,  ST_YMin(p.bbox_geom) AS south,
         ST_XMax(p.bbox_geom) AS east,  ST_YMax(p.bbox_geom) AS north
    FROM projects p ORDER BY p.created_at, p.id`;

interface ProjectRow {
  slug: string; name: string; state_code: string; district_code: string;
  scheme_code: string; status: Project['status']; created_at: Date | string;
  stats: ProjectStats | null;
  west: number; south: number; east: number; north: number;
}

/**
 * Registry rows from PostGIS, or null when there is no PostGIS answer.
 *
 * Null and [] are different: null means "ask the snapshot", [] means "the
 * database is up and there genuinely are no projects".
 */
export async function projectsFromDb(): Promise<Project[] | null> {
  if (!(await usingDb())) return null;
  try {
    const rows = await q<ProjectRow>(PROJECTS_SQL);
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      bbox: [r.west, r.south, r.east, r.north] as [number, number, number, number],
      state_code: r.state_code,
      district_code: r.district_code,
      scheme_code: r.scheme_code,
      status: r.status,
      created_at: new Date(r.created_at).toISOString(),
      stats: r.stats && Object.keys(r.stats).length ? r.stats : null,
    }));
  } catch {
    // No projects table -- a pre-migration volume. The snapshot registry is
    // the right answer there, and it names the demo project.
    return null;
  }
}

/** True when PostGIS holds rows for this project. Used by the 404/503 gate. */
export async function projectHasRows(slug: string): Promise<boolean> {
  const scope = await scopeFor(slug);
  if (!scope) return false;
  const r = await viaDb(slug, async (s) => {
    const f = filter(s, 'WHERE b.project_id = $P');
    const rows = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM building b ${f.clause}`, f.params);
    return rows[0].n > 0;
  });
  return r.ok && r.value;
}

// ---------------------------------------------------------------------------
// Cadastre SQL. Each is a function of the scope so the project filter and its
// placeholder number are generated together.
// ---------------------------------------------------------------------------

function buildingsSql(scope: Scope) {
  const f = filter(scope, 'WHERE b.project_id = $P');
  return {
    sql: `
  SELECT json_build_object(
    'type','FeatureCollection',
    'aoi',$${f.params.length + 1}::text,
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',b.id,
      'geometry', ST_AsGeoJSON(b.footprint, 7)::json,
      'properties', json_build_object(
        'id',b.id,'ulpin',b.ulpin,'parcel_id',b.parcel_id,
        'height_m',b.height_m,'floors',b.floors,'basements',b.basements,
        'ground_elev',b.ground_elev,'use_type',b.use_type,
        'height_source',b.height_source,'survey_synthetic',b.survey_synthetic,'name',b.name,'address',b.address,
        'osm_id',b.osm_id))),'[]'::json)) AS fc
  FROM building b ${f.clause}`,
    params: [...f.params, scope.name],
  };
}

function parcelsSql(scope: Scope) {
  const f = filter(scope, 'WHERE p.project_id = $P');
  return {
    sql: `
  SELECT json_build_object(
    'type','FeatureCollection',
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',p.id,
      'geometry', ST_AsGeoJSON(p.geom, 7)::json,
      'properties', json_build_object(
        'id',p.id,'ulpin',p.ulpin,'area_m2',p.area_m2,'owner',p.owner))),'[]'::json)) AS fc
  FROM parcel p ${f.clause}`,
    params: f.params,
  };
}

function utilitiesSql(scope: Scope) {
  const f = filter(scope, 'WHERE u.project_id = $P');
  return {
    sql: `
  SELECT json_build_object(
    'type','FeatureCollection',
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',u.id,
      'geometry', ST_AsGeoJSON(u.geom_3d, 7)::json,
      'properties', json_build_object(
        'id',u.id,'asset_type',u.asset_type,'depth_m',u.depth_m,
        'radius_m',u.radius_m,'authority',u.authority,'status',u.status,
        'in_conflict', EXISTS (SELECT 1 FROM conflict c
                                WHERE c.a_type='utility' AND c.a_id=u.id)))),'[]'::json)) AS fc
  FROM utility u ${f.clause}`,
    params: f.params,
  };
}

// The conflict table has no project_id of its own: a conflict is a relation
// between a utility and a floor, and both already belong to a project. It is
// scoped through the building join it already had.
function conflictsSql(scope: Scope) {
  const f = filter(scope, 'WHERE b.project_id = $P');
  return {
    sql: `
  SELECT COALESCE(json_agg(json_build_object(
    'id',c.id,'kind',c.kind,'detected_at',c.detected_at,
    'utility_id',u.id,'asset_type',u.asset_type,'authority',u.authority,
    'status',u.status,'depth_m',u.depth_m,
    'floor_id',f.id,'floor_ulpin',f.ulpin,'level_no',f.level_no,
    'building_id',b.id,'building_ulpin',b.ulpin,'building_name',b.name)
    ORDER BY c.id),'[]'::json) AS rows
  FROM conflict c
  JOIN utility u  ON u.id = c.a_id
  JOIN floor f    ON f.id = c.b_id
  JOIN building b ON b.id = f.building_id ${f.clause}`,
    params: f.params,
  };
}

function detailSql(scope: Scope, id: number) {
  const f = filter(scope, 'AND b.project_id = $P', [id]);
  return {
    sql: `
  SELECT json_build_object(
    'building', json_build_object(
      'id',b.id,'ulpin',b.ulpin,'parcel_id',b.parcel_id,'height_m',b.height_m,
      'floors',b.floors,'basements',b.basements,'ground_elev',b.ground_elev,
      'use_type',b.use_type,'height_source',b.height_source,'survey_synthetic',b.survey_synthetic,'name',b.name,
      'address',b.address,'osm_id',b.osm_id,
      'footprint', ST_AsGeoJSON(b.footprint, 7)::json),
    'parcel', (SELECT json_build_object('id',p.id,'ulpin',p.ulpin,
         'area_m2',p.area_m2,'owner',p.owner,
         'geometry', ST_AsGeoJSON(p.geom, 7)::json)
       FROM parcel p WHERE p.id = b.parcel_id),
    'floors', COALESCE((SELECT json_agg(json_build_object(
         'id',f.id,'ulpin',f.ulpin,'level_no',f.level_no,'z_min',f.z_min,
         'z_max',f.z_max,'detect_source',f.detect_source,
         'ring', ST_AsGeoJSON(ST_Force2D(b.footprint), 7)::json)
         ORDER BY f.level_no)
       FROM floor f WHERE f.building_id = b.id),'[]'::json),
    'units', COALESCE((SELECT json_agg(json_build_object(
         'id',u.id,'floor_id',u.floor_id,'ulpin',u.ulpin,'unit_no',u.unit_no,
         'z_min',u.z_min,'z_max',u.z_max,'carpet_m2',u.carpet_m2,
         'built_m2',u.built_m2,'tenure',u.tenure,'encumbrance',u.encumbrance,
         'level_no',f2.level_no,
         'ring', ST_AsGeoJSON(ST_Force2D(ST_GeometryN(u.geom_3d,1)), 7)::json)
         ORDER BY f2.level_no, u.unit_no)
       FROM unit u JOIN floor f2 ON f2.id = u.floor_id
       WHERE f2.building_id = b.id),'[]'::json)
  ) AS doc
  FROM building b WHERE b.id = $1 ${f.clause}`,
    params: f.params,
  };
}

// Three subtleties here:
//
// 1. PostgreSQL only allows output column names or ordinals in a UNION's ORDER
//    BY, so the ranking expression sits outside the union rather than on it.
//
// 2. ST_3DIntersects treats a POLYHEDRALSURFACE as a *shell*: a point strictly
//    inside the prism does not intersect it. ST_MakeSolid promotes the shell to
//    a solid so the test becomes real volume containment. The `&&` prefilter
//    runs first on the 2D GIST index, so ST_MakeSolid only ever evaluates for
//    the handful of candidates under the cursor.
//
// 3. floor and unit have no project_id -- they inherit one through building --
//    so they are scoped by an extra join rather than an extra predicate. The
//    join is on the indexed FK and runs after the `&&` prefilter, so it costs
//    a lookup on the handful of candidates rather than a scan.
function querySql(scope: Scope, lon: number, lat: number, z: number) {
  const f = filter(scope, '$P', [lon, lat, z]);
  const p = f.clause; // '' in legacy mode, '$4' when scoped
  const parcelF = p ? `AND p.project_id = ${p}` : '';
  const buildingF = p ? `AND b.project_id = ${p}` : '';
  const floorJoin = p
    ? `JOIN building fb ON fb.id = f.building_id AND fb.project_id = ${p}` : '';
  const unitJoin = p
    ? `JOIN floor uf ON uf.id = u.floor_id
       JOIN building ub ON ub.id = uf.building_id AND ub.project_id = ${p}` : '';
  return {
    sql: `
  WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1,$2,$3),4326) AS g,
                     ST_SetSRID(ST_MakePoint($1,$2),4326)    AS g2)
  SELECT s.level, s.id, s.ulpin, s.label, s.z_min, s.z_max, s.provenance
  FROM (
    SELECT 'parcel' AS level, p.id, p.ulpin, p.owner AS label,
           NULL::float8 AS z_min, NULL::float8 AS z_max, NULL::text AS provenance
      FROM parcel p, pt WHERE ST_Intersects(p.geom, pt.g2) ${parcelF}
    UNION ALL
    SELECT 'building', b.id, b.ulpin,
           COALESCE(b.name, initcap(b.use_type) || ' building'),
           b.ground_elev, b.ground_elev + b.height_m, b.height_source
      FROM building b, pt
     WHERE ST_Intersects(b.footprint, pt.g2)
       AND $3 BETWEEN b.ground_elev - b.basements * 3.2 AND b.ground_elev + b.height_m
       ${buildingF}
    UNION ALL
    SELECT 'floor', f.id, f.ulpin, 'Level ' || f.level_no, f.z_min, f.z_max, f.detect_source
      FROM floor f ${floorJoin}, pt
     WHERE f.geom && pt.g2 AND ST_3DIntersects(ST_MakeSolid(f.geom), pt.g)
    UNION ALL
    SELECT 'unit', u.id, u.ulpin, u.unit_no, u.z_min, u.z_max, NULL
      FROM unit u ${unitJoin}, pt
     WHERE u.geom_3d && pt.g2 AND ST_3DIntersects(ST_MakeSolid(u.geom_3d), pt.g)
  ) s
  ORDER BY CASE s.level WHEN 'parcel' THEN 1 WHEN 'building' THEN 2
                        WHEN 'floor' THEN 3 ELSE 4 END, s.id`,
    params: f.params,
  };
}

/** Raw footprints, from PostGIS or the snapshot. NOT enriched. */
async function buildingsFC(slug: string): Promise<GeoFC<BuildingProps>> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = buildingsSql(scope);
    return (await q<{ fc: GeoFC<BuildingProps> }>(sql, params))[0].fc;
  });
  if (r.ok) return r.value;
  return snapshot<GeoFC<BuildingProps>>(slug, 'buildings.json');
}

/**
 * A memo whose entries expire when the project's edits change.
 *
 * Used three times below with three different value types, which is the only
 * reason it is a helper rather than three pairs of module-level variables --
 * those were what made the single-project version of this file hard to reason
 * about once a second key had to be added to each of them.
 */
function editAwareCache<T>() {
  const store = new Map<string, { rev: number; value: T }>();
  return {
    get(slug: string): T | null {
      const hit = store.get(slug);
      return hit && hit.rev === editsRev(slug) ? hit.value : null;
    },
    set(slug: string, value: T): T {
      store.set(slug, { rev: editsRev(slug), value });
      return value;
    },
  };
}

/**
 * buildingId -> real unit totals, memoised per project.
 *
 * THE CONSISTENCY TRAP THIS SOLVES. getBuildings() has no unit rows in hand,
 * so a naive implementation would estimate built_up_m2 from the footprint
 * while getBuildingDetail() summed the real unit areas -- two different
 * numbers for the same building, and the DetailPanel reads its header rows
 * from the FeatureCollection and the rest from the detail document. Both
 * paths take their totals from this one index instead.
 *
 * On the snapshot path this walks detail.json once. That file is already
 * parsed and held by `fileCache` for getBuildingDetail, so the cost is paid
 * once per project per process and never again.
 */
const unitIndexCache = editAwareCache<Map<number, UnitFacts>>();

async function unitIndex(slug: string): Promise<Map<number, UnitFacts>> {
  const hit = unitIndexCache.get(slug);
  if (hit) return hit;
  const out = new Map<number, UnitFacts>();

  const viaSql = await viaDb(slug, async (scope) => {
    const f = filter(scope, 'WHERE b.project_id = $P');
    return q<{ building_id: number; built: string; n: number }>(
      'SELECT f.building_id, sum(u.built_m2) AS built, count(*)::int AS n '
      + 'FROM unit u JOIN floor f ON f.id = u.floor_id '
      + `JOIN building b ON b.id = f.building_id ${f.clause} `
      + 'GROUP BY f.building_id', f.params);
  });
  if (viaSql.ok) {
    for (const row of viaSql.value) {
      out.set(row.building_id, { builtM2: Number(row.built) || 0, unitCount: row.n });
    }
    return unitIndexCache.set(slug, out);
  }

  const all = await snapshot<Record<string, BuildingDetail>>(slug, 'detail.json');
  for (const [key, doc] of Object.entries(all)) {
    let builtM2 = 0;
    for (const u of doc.units ?? []) builtM2 += u.built_m2;
    out.set(Number(key), { builtM2, unitCount: doc.units?.length ?? 0 });
  }
  return unitIndexCache.set(slug, out);
}

/**
 * Vertices of every street in a project, for the nearest-street lookup the
 * generated addresses use.
 *
 * A generated address should at least name a street that really runs past the
 * building. Built from the same derived artefact the map draws, and degrades
 * to an empty list (the generator then falls back to the project name) when it
 * is absent -- which is the normal state for a project whose roads artefact
 * has not been built.
 */
const streetIndexCache = new Map<string, { lon: number; lat: number; name: string }[]>();

async function streetIndex(
  slug: string,
): Promise<{ lon: number; lat: number; name: string }[]> {
  const hit = streetIndexCache.get(slug);
  if (hit) return hit;
  let pts: { lon: number; lat: number; name: string }[] = [];
  try {
    const fc = await snapshot<GeoFC<RoadProps>>(slug, 'roads.json');
    for (const f of fc.features) {
      const parts = f.geometry.type === 'MultiLineString'
        ? (f.geometry.coordinates as number[][][])
        : [f.geometry.coordinates as number[][]];
      for (const line of parts) {
        // Every third vertex is plenty: this is a nearest-street lookup, not a
        // routing index, and it keeps the scan small.
        for (let i = 0; i < line.length; i += 3) {
          pts.push({ lon: line[i][0], lat: line[i][1], name: f.properties.name });
        }
      }
    }
  } catch {
    pts = [];
  }
  streetIndexCache.set(slug, pts);
  return pts;
}

function nearestStreetFactory(pts: { lon: number; lat: number; name: string }[]) {
  return (lon: number, lat: number): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    for (const p of pts) {
      // Squared degrees: monotonic in true distance at this scale, and this
      // runs once per building over a few thousand points.
      const dx = p.lon - lon;
      const dy = p.lat - lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p.name; }
    }
    return best;
  };
}

/**
 * Apply a user's edits over a record, in two passes.
 *
 * The two passes answer different questions and neither alone is correct:
 *
 *   Pass 1 overlays only the fields that exist in the REAL schema (name,
 *   address, floors, height_m) BEFORE enrichment, so that everything the
 *   generator derives from them -- the built-up estimate, the occupancy band,
 *   the permitted building subtypes -- is derived from the edited values
 *   rather than the originals.
 *
 *   Pass 2 overlays every edited field AFTER enrichment, so that a value the
 *   user typed explicitly wins outright over whatever the generator produced
 *   for it.
 *
 * A single pass in either direction gets one of the two wrong: applied only
 * before, an explicit built-up area is overwritten by the estimate; applied
 * only after, editing the storey count leaves every derived figure stale.
 */
const REAL_SCHEMA_FIELDS = ['name', 'address', 'floors', 'height_m'] as const;

function preEnrich(b: BuildingProps, edit: Partial<BuildingEdit> | null): BuildingProps {
  if (!edit) return b;
  const out = { ...b };
  for (const f of REAL_SCHEMA_FIELDS) {
    if (edit[f] !== undefined) (out as Record<string, unknown>)[f] = edit[f];
  }
  return out;
}

function postEnrich(
  b: EnrichedBuilding,
  edit: Partial<BuildingEdit> | null,
): EnrichedBuilding {
  if (!edit) return b;
  const out: EnrichedBuilding = { ...b, ...edit };
  // An edited name or address is no longer an OSM tag nor a generated value;
  // it is the user's. The panel needs to be able to say so.
  if (edit.name !== undefined) out.name_source = 'generated';
  if (edit.address !== undefined) out.address_source = 'generated';
  return out;
}

/**
 * Footprints, with the synthetic register attached.
 *
 * The enrichment is the LAST transform before the data leaves this module and
 * it is applied on both backends, so PostGIS and the snapshot serve identical
 * records. See lib/mock/building.ts for what it may and may not invent.
 *
 * Memoised per project on the edit revision.
 *
 * Enrichment walks 384 buildings and, for each, scans ~3,800 street vertices
 * to find the one its generated address should name -- about 1.5M distance
 * comparisons. Cheap once, wasteful on every request, and queryPoint calls
 * this too, so a point query was paying for the whole collection. The result
 * is a pure function of (raw data, unit index, streets, edits), and only the
 * last of those can change at runtime.
 */
const enrichedCache = editAwareCache<GeoFC<EnrichedBuilding>>();

export async function getBuildings(slug: string): Promise<GeoFC<EnrichedBuilding>> {
  const hit = enrichedCache.get(slug);
  if (hit) return hit;

  const [fc, units, streets, edits] = await Promise.all([
    buildingsFC(slug), unitIndex(slug), streetIndex(slug), allEdits(slug),
  ]);
  // The project's own name, so a generated address says where the building
  // actually is. It rides on the FeatureCollection from both backends.
  const locality = fc.aoi ?? null;
  const pre: GeoFC<BuildingProps> = edits.size === 0 ? fc : {
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      properties: preEnrich(f.properties, edits.get(f.properties.id) ?? null),
    })),
  };
  const enriched = enrichCollection(pre, units, nearestStreetFactory(streets), locality);
  const out: GeoFC<EnrichedBuilding> = edits.size === 0 ? enriched : {
    ...enriched,
    features: enriched.features.map((f) => ({
      ...f,
      properties: postEnrich(f.properties, edits.get(f.properties.id) ?? null),
    })),
  };
  return enrichedCache.set(slug, out);
}

export async function getParcels(slug: string): Promise<GeoFC<ParcelInfo>> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = parcelsSql(scope);
    return (await q<{ fc: GeoFC<ParcelInfo> }>(sql, params))[0].fc;
  });
  if (r.ok) return r.value;
  return snapshot<GeoFC<ParcelInfo>>(slug, 'parcels.json');
}

export async function getUtilities(slug: string): Promise<GeoFC<UtilityProps>> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = utilitiesSql(scope);
    return (await q<{ fc: GeoFC<UtilityProps> }>(sql, params))[0].fc;
  });
  if (r.ok) return r.value;
  return snapshot<GeoFC<UtilityProps>>(slug, 'utilities.json');
}

/**
 * Streets. Snapshot-only, and deliberately so.
 *
 * db/01_schema.sql has no road table: scripts/utilities.sql builds one as an
 * UNLOGGED temp table to offset utility corridors from and drops it again. So
 * unlike buildings and parcels there is no PostGIS answer to prefer here, and
 * wrapping this in viaDb() would only imply one exists. The centrelines are
 * merged, named and measured at build time by scripts/build_roads.mjs.
 *
 * A project whose artefact has not been built answers with an empty collection
 * that says so, rather than a 500. Streets are orientation context; their
 * absence must not read as "this project is broken", and it is the same
 * honest caveat streets have always carried.
 */
export async function getRoads(slug: string): Promise<GeoFC<RoadProps>> {
  try {
    return await snapshot<GeoFC<RoadProps>>(slug, 'roads.json');
  } catch {
    return {
      type: 'FeatureCollection',
      features: [],
      _disclaimer:
        `No street artefact has been built for "${slug}". Streets are derived `
        + 'at build time by scripts/build_roads.mjs and written to '
        + `data/api/${slug}/roads.json; until that runs this project has no `
        + 'centrelines to draw. Nothing else about the project is affected.',
    } as GeoFC<RoadProps>;
  }
}

export async function getConflicts(slug: string): Promise<ConflictRow[]> {
  return getPristineConflicts(slug);
}

/**
 * The PRISTINE conflict set: every utility/floor intersection as it sits
 * in PostGIS or in the snapshot, with no edit overlay.
 *
 * The cache stores THIS value. When a building is edited (height_m or
 * basements), the floor's z range changes, and some conflicts that
 * existed in the pristine set are no longer intersections and some new
 * ones are. The route handler applies an overlay that recomputes
 * conflicts for the edited buildings and merges the result over the
 * pristine set -- the cache itself is never touched by a PATCH.
 */
export async function getPristineConflicts(slug: string): Promise<ConflictRow[]> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = conflictsSql(scope);
    return (await q<{ rows: ConflictRow[] }>(sql, params))[0].rows;
  });
  if (r.ok) return r.value;
  return snapshot<ConflictRow[]>(slug, 'conflicts.json');
}

/**
 * The PRISTINE building detail: the document exactly as it lives in PostGIS
 * or in the snapshot's detail.json, with no edit overlay and no enrichment.
 *
 * The Redis cache stores THIS value, not the enriched one. The route
 * handler reads the cached pristine document and applies the enrichment
 * (which is also where the edit overlay lives) on every request, so a
 * PATCH never has to invalidate the cache: the cache holds the un-edited
 * truth, and the overlay is a pure function applied over it.
 *
 * `null` is a legitimate return value -- a 404 -- and the caller is
 * responsible for not caching it. The brief is explicit on that: "never
 * cache a 404 or 503".
 */
export async function getPristineBuildingDetail(
  slug: string,
  id: number,
): Promise<BuildingDetail | null> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = detailSql(scope, id);
    const rows = await q<{ doc: BuildingDetail }>(sql, params);
    return rows[0]?.doc ?? null;
  });
  if (r.ok) return r.value;
  const all = await snapshot<Record<string, BuildingDetail>>(slug, 'detail.json');
  return all[String(id)] ?? null;
}

/**
 * Run the enrichment (and edit overlay) over an already-fetched pristine
 * BuildingDetail. Exported so the read-through cache in lib/cache/store.ts
 * can hold the PRISTINE document in Redis and re-run enrichment on every
 * read -- the cached byte is small and stable, the overlay is the only
 * thing that can change, and running it on every read is the "no
 * invalidation to get wrong" property the cache exists to provide.
 *
 * `null` is returned only when the raw input is null; the enrichment
 * itself never nulls a document. The 404 signal therefore belongs to
 * the pristine read, not the overlay.
 */
export async function enrichBuildingDetail(
  slug: string,
  raw: BuildingDetail,
): Promise<BuildingDetail> {
  // Same generator, same seeds and the same unit index getBuildings uses, so
  // the header rows the panel reads from the FeatureCollection and the rows it
  // reads from here can never disagree.
  const id = raw.building.id;
  const [units, streets, edit, collection] = await Promise.all([
    unitIndex(slug), streetIndex(slug), editsFor(slug, id), buildingsFC(slug),
  ]);
  const ring = (raw.building.footprint?.coordinates as number[][][] | undefined)?.[0];
  let lon = 0;
  let lat = 0;
  if (ring && ring.length > 1) {
    const n = ring.length - 1;
    for (let i = 0; i < n; i++) { lon += ring[i][0] / n; lat += ring[i][1] / n; }
  }
  const enriched = postEnrich(
    enrichBuilding(preEnrich(raw.building, edit), {
      footprint: raw.building.footprint,
      units: units.get(id) ?? null,
      nearestStreet: nearestStreetFactory(streets)(lon, lat),
      // Same locality the collection path uses, so the panel's header rows and
      // its detail rows cannot disagree about which city the building is in.
      locality: collection.aoi ?? null,
    }),
    edit,
  );
  return { ...raw, building: { ...enriched, footprint: raw.building.footprint } };
}

export async function getBuildingDetail(
  slug: string,
  id: number,
): Promise<BuildingDetail | null> {
  const raw = await getPristineBuildingDetail(slug, id);
  if (!raw) return null;
  return enrichBuildingDetail(slug, raw);
}

/**
 * Every entity whose 3D volume contains (lon, lat, z), coarse to fine.
 * ST_3DIntersects against a POINT Z is the containment test on the DB path.
 */
export async function queryPoint(
  slug: string,
  lon: number,
  lat: number,
  z: number,
): Promise<StackHit[]> {
  const hits = await getPristineQueryPoint(slug, lon, lat, z);

  // The building label is built inside the query SQL (and its JS twin),
  // neither of which can reach the TypeScript enrichment. Reconciled here so
  // this third read path names a building the same way the other two do.
  const named = await getBuildings(slug);
  const byId = new Map(named.features.map((f) => [f.properties.id, f.properties]));
  return hits.map((h) => {
    const p = h.level === 'building' ? byId.get(h.id) : undefined;
    return p && p.name ? { ...h, label: p.name } : h;
  });
}

/**
 * The PRISTINE point query: the stack of entities at (lon, lat, z) as
 * PostGIS or the snapshot computes it, with the building label as it
 * sits in the database (or absent).
 *
 * The cache stores THIS value. When a building is edited, the
 * containment test's result can change for points inside the edited
 * building's volume (height_m and basements both feed the test), and
 * the building's name can change. The route handler applies an overlay
 * that adjusts z values and labels for edited buildings over the
 * cached pristine result.
 */
export async function getPristineQueryPoint(
  slug: string,
  lon: number,
  lat: number,
  z: number,
): Promise<StackHit[]> {
  const scope = await scopeFor(slug);
  if (scope) {
    const { sql, params } = querySql(scope, lon, lat, z);
    return q<StackHit>(sql, params);
  }
  return queryPointFromSnapshot(slug, lon, lat, z);
}

/** Ray-casting point-in-ring; exact for the vertical prisms this schema stores. */
function inRing(ring: number[][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function firstRing(g: { coordinates: unknown }): number[][] {
  return (g.coordinates as number[][][])[0];
}

interface SnapParcel {
  properties: { id: number; ulpin: string; owner: string };
  geometry: { coordinates: unknown };
}
interface SnapBuilding {
  properties: {
    id: number; ulpin: string; name: string | null; use_type: string;
    ground_elev: number; height_m: number; basements: number; height_source: string;
  };
  geometry: { coordinates: unknown };
}

async function queryPointFromSnapshot(
  slug: string,
  lon: number,
  lat: number,
  z: number,
): Promise<StackHit[]> {
  const out: StackHit[] = [];
  const parcels = await snapshot<{ features: SnapParcel[] }>(slug, 'parcels.json');
  const buildings = (await buildingsFC(slug)) as unknown as { features: SnapBuilding[] };

  for (const f of parcels.features) {
    if (inRing(firstRing(f.geometry), lon, lat)) {
      out.push({
        level: 'parcel', id: f.properties.id, ulpin: f.properties.ulpin,
        label: f.properties.owner, z_min: null, z_max: null, provenance: null,
      });
    }
  }

  for (const f of buildings.features) {
    const p = f.properties;
    if (!inRing(firstRing(f.geometry), lon, lat)) continue;
    const zBottom = p.ground_elev - p.basements * 3.2;
    const zTop = p.ground_elev + p.height_m;
    if (z < zBottom || z > zTop) continue;

    const fallbackLabel = p.use_type.charAt(0).toUpperCase() + p.use_type.slice(1) + ' building';
    out.push({
      level: 'building', id: p.id, ulpin: p.ulpin, label: p.name ?? fallbackLabel,
      z_min: p.ground_elev, z_max: zTop,
      provenance: p.height_source as StackHit['provenance'],
    });

    const detail = await getBuildingDetail(slug, p.id);
    if (!detail) continue;
    for (const fl of detail.floors) {
      if (z >= fl.z_min && z <= fl.z_max) {
        out.push({
          level: 'floor', id: fl.id, ulpin: fl.ulpin, label: `Level ${fl.level_no}`,
          z_min: fl.z_min, z_max: fl.z_max, provenance: fl.detect_source,
        });
      }
    }
    for (const u of detail.units) {
      if (z >= u.z_min && z <= u.z_max && inRing(firstRing(u.ring), lon, lat)) {
        out.push({
          level: 'unit', id: u.id, ulpin: u.ulpin, label: u.unit_no,
          z_min: u.z_min, z_max: u.z_max, provenance: null,
        });
      }
    }
  }

  const rank = { parcel: 1, building: 2, floor: 3, unit: 4 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
