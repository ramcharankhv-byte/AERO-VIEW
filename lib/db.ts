import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type {
  BuildingDetail, BuildingProps, ConflictRow, EnrichedBuilding, GeoFC,
  ParcelInfo, RoadProps, StackHit, UtilityProps,
} from './types';
import { enrichBuilding, enrichCollection, type UnitFacts } from './mock/building';
import { allEdits, editsFor, editsRev } from './data/edits';
import type { BuildingEdit } from './data/building-schema';

/**
 * Data access with two backends.
 *
 * PostGIS is the source of truth and does the real spatial work (ST_3DIntersects
 * over PolyhedralSurface solids). When it is unreachable -- typically because
 * docker-compose is not running -- we serve the committed snapshots in
 * data/api/, which scripts/05_export_static.py generated FROM that same
 * database. The snapshot is never an alternative implementation of the spatial
 * logic; it is a cache of its output, so the two cannot drift in behaviour.
 *
 * The one genuine difference is /api/query: the point-in-volume test runs in
 * SQL when the DB is up, and as an equivalent prism test in JS when it is not.
 * Both are exact for vertical prisms, which is all this schema stores.
 */

const DATA_DIR = path.join(process.cwd(), 'data', 'api');
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

/**
 * Run a PostGIS query, or report that the snapshot should serve instead.
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
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (!(await usingDb())) return { ok: false };
  try {
    return { ok: true, value: await run() };
  } catch {
    return { ok: false };
  }
}

async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(sql, params as never[]);
  return res.rows as T[];
}

const fileCache = new Map<string, unknown>();
async function snapshot<T>(name: string): Promise<T> {
  if (fileCache.has(name)) return fileCache.get(name) as T;
  const raw = await fs.readFile(path.join(DATA_DIR, name), 'utf-8');
  const parsed = JSON.parse(raw);
  fileCache.set(name, parsed);
  return parsed as T;
}

export async function backend(): Promise<'postgis' | 'snapshot'> {
  return (await usingDb()) ? 'postgis' : 'snapshot';
}

const BUILDINGS_SQL = `
  SELECT json_build_object(
    'type','FeatureCollection',
    'aoi','Siripuram, Visakhapatnam',
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',b.id,
      'geometry', ST_AsGeoJSON(b.footprint, 7)::json,
      'properties', json_build_object(
        'id',b.id,'ulpin',b.ulpin,'parcel_id',b.parcel_id,
        'height_m',b.height_m,'floors',b.floors,'basements',b.basements,
        'ground_elev',b.ground_elev,'use_type',b.use_type,
        'height_source',b.height_source,'survey_synthetic',b.survey_synthetic,'name',b.name,'address',b.address,
        'osm_id',b.osm_id))),'[]'::json)) AS fc
  FROM building b`;

const PARCELS_SQL = `
  SELECT json_build_object(
    'type','FeatureCollection',
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',p.id,
      'geometry', ST_AsGeoJSON(p.geom, 7)::json,
      'properties', json_build_object(
        'id',p.id,'ulpin',p.ulpin,'area_m2',p.area_m2,'owner',p.owner))),'[]'::json)) AS fc
  FROM parcel p`;

const UTILITIES_SQL = `
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
  FROM utility u`;

const CONFLICTS_SQL = `
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
  JOIN building b ON b.id = f.building_id`;

const DETAIL_SQL = `
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
  FROM building b WHERE b.id = $1`;

// Two subtleties here:
//
// 1. PostgreSQL only allows output column names or ordinals in a UNION's ORDER
//    BY, so the ranking expression sits outside the union rather than on it.
//
// 2. ST_3DIntersects treats a POLYHEDRALSURFACE as a *shell*: a point strictly
//    inside the prism does not intersect it. ST_MakeSolid promotes the shell to
//    a solid so the test becomes real volume containment. The `&&` prefilter
//    runs first on the 2D GIST index, so ST_MakeSolid only ever evaluates for
//    the handful of candidates under the cursor.
const QUERY_SQL = `
  WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1,$2,$3),4326) AS g,
                     ST_SetSRID(ST_MakePoint($1,$2),4326)    AS g2)
  SELECT s.level, s.id, s.ulpin, s.label, s.z_min, s.z_max, s.provenance
  FROM (
    SELECT 'parcel' AS level, p.id, p.ulpin, p.owner AS label,
           NULL::float8 AS z_min, NULL::float8 AS z_max, NULL::text AS provenance
      FROM parcel p, pt WHERE ST_Intersects(p.geom, pt.g2)
    UNION ALL
    SELECT 'building', b.id, b.ulpin,
           COALESCE(b.name, initcap(b.use_type) || ' building'),
           b.ground_elev, b.ground_elev + b.height_m, b.height_source
      FROM building b, pt
     WHERE ST_Intersects(b.footprint, pt.g2)
       AND $3 BETWEEN b.ground_elev - b.basements * 3.2 AND b.ground_elev + b.height_m
    UNION ALL
    SELECT 'floor', f.id, f.ulpin, 'Level ' || f.level_no, f.z_min, f.z_max, f.detect_source
      FROM floor f, pt
     WHERE f.geom && pt.g2 AND ST_3DIntersects(ST_MakeSolid(f.geom), pt.g)
    UNION ALL
    SELECT 'unit', u.id, u.ulpin, u.unit_no, u.z_min, u.z_max, NULL
      FROM unit u, pt
     WHERE u.geom_3d && pt.g2 AND ST_3DIntersects(ST_MakeSolid(u.geom_3d), pt.g)
  ) s
  ORDER BY CASE s.level WHEN 'parcel' THEN 1 WHEN 'building' THEN 2
                        WHEN 'floor' THEN 3 ELSE 4 END, s.id`;

/** Raw footprints, from PostGIS or the snapshot. NOT enriched. */
async function buildingsFC(): Promise<GeoFC<BuildingProps>> {
  const r = await viaDb(async () =>
    (await q<{ fc: GeoFC<BuildingProps> }>(BUILDINGS_SQL))[0].fc);
  if (r.ok) return r.value;
  return snapshot<GeoFC<BuildingProps>>('buildings.json');
}

/**
 * buildingId -> real unit totals, memoised for the process.
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
 * once per process and never again.
 */
let unitIndexCache: Map<number, UnitFacts> | null = null;
let unitIndexRev = -1;
async function unitIndex(): Promise<Map<number, UnitFacts>> {
  // Keyed on the edit revision so a save invalidates the memo with an integer
  // comparison rather than a deep check.
  if (unitIndexCache && unitIndexRev === editsRev()) return unitIndexCache;
  unitIndexRev = editsRev();
  const out = new Map<number, UnitFacts>();

  const viaSql = await viaDb(async () =>
    q<{ building_id: number; built: string; n: number }>(
      'SELECT f.building_id, sum(u.built_m2) AS built, count(*)::int AS n '
      + 'FROM unit u JOIN floor f ON f.id = u.floor_id GROUP BY f.building_id'));
  if (viaSql.ok) {
    for (const row of viaSql.value) {
      out.set(row.building_id, { builtM2: Number(row.built) || 0, unitCount: row.n });
    }
    unitIndexCache = out;
    return out;
  }

  const all = await snapshot<Record<string, BuildingDetail>>('detail.json');
  for (const [key, doc] of Object.entries(all)) {
    let builtM2 = 0;
    for (const u of doc.units ?? []) builtM2 += u.built_m2;
    out.set(Number(key), { builtM2, unitCount: doc.units?.length ?? 0 });
  }
  unitIndexCache = out;
  return out;
}

/**
 * Vertices of every street, for the nearest-street lookup the generated
 * addresses use.
 *
 * A generated address should at least name a street that really runs past the
 * building. Built from the same derived artefact the map draws, and degrades
 * to an empty list (the generator then says "Siripuram") when it is absent.
 */
let streetIndexCache: { lon: number; lat: number; name: string }[] | null = null;
async function streetIndex(): Promise<{ lon: number; lat: number; name: string }[]> {
  if (streetIndexCache) return streetIndexCache;
  try {
    const fc = await snapshot<GeoFC<RoadProps>>('roads.json');
    const pts: { lon: number; lat: number; name: string }[] = [];
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
    streetIndexCache = pts;
  } catch {
    streetIndexCache = [];
  }
  return streetIndexCache;
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
 */
let enrichedCache: GeoFC<EnrichedBuilding> | null = null;
let enrichedRev = -1;

export async function getBuildings(): Promise<GeoFC<EnrichedBuilding>> {
  // Memoised on the edit revision.
  //
  // Enrichment walks 384 buildings and, for each, scans ~3,800 street vertices
  // to find the one its generated address should name -- about 1.5M distance
  // comparisons. Cheap once, wasteful on every request, and queryPoint calls
  // this too, so a point query was paying for the whole collection. The result
  // is a pure function of (raw data, unit index, streets, edits), and only the
  // last of those can change at runtime.
  if (enrichedCache && enrichedRev === editsRev()) return enrichedCache;

  const [fc, units, streets, edits] = await Promise.all([
    buildingsFC(), unitIndex(), streetIndex(), allEdits(),
  ]);
  const pre: GeoFC<BuildingProps> = edits.size === 0 ? fc : {
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      properties: preEnrich(f.properties, edits.get(f.properties.id) ?? null),
    })),
  };
  const enriched = enrichCollection(pre, units, nearestStreetFactory(streets));
  const out: GeoFC<EnrichedBuilding> = edits.size === 0 ? enriched : {
    ...enriched,
    features: enriched.features.map((f) => ({
      ...f,
      properties: postEnrich(f.properties, edits.get(f.properties.id) ?? null),
    })),
  };
  enrichedCache = out;
  enrichedRev = editsRev();
  return out;
}

export async function getParcels(): Promise<GeoFC<ParcelInfo>> {
  const r = await viaDb(async () =>
    (await q<{ fc: GeoFC<ParcelInfo> }>(PARCELS_SQL))[0].fc);
  if (r.ok) return r.value;
  return snapshot<GeoFC<ParcelInfo>>('parcels.json');
}

export async function getUtilities(): Promise<GeoFC<UtilityProps>> {
  const r = await viaDb(async () =>
    (await q<{ fc: GeoFC<UtilityProps> }>(UTILITIES_SQL))[0].fc);
  if (r.ok) return r.value;
  return snapshot<GeoFC<UtilityProps>>('utilities.json');
}

/**
 * Streets. Snapshot-only, and deliberately so.
 *
 * db/01_schema.sql has no road table: scripts/utilities.sql builds one as an
 * UNLOGGED temp table to offset utility corridors from and drops it again. So
 * unlike buildings and parcels there is no PostGIS answer to prefer here, and
 * wrapping this in viaDb() would only imply one exists. The centrelines are
 * merged, named and measured at build time by scripts/build_roads.mjs.
 */
export async function getRoads(): Promise<GeoFC<RoadProps>> {
  return snapshot<GeoFC<RoadProps>>('roads.json');
}

export async function getConflicts(): Promise<ConflictRow[]> {
  const r = await viaDb(async () =>
    (await q<{ rows: ConflictRow[] }>(CONFLICTS_SQL))[0].rows);
  if (r.ok) return r.value;
  return snapshot<ConflictRow[]>('conflicts.json');
}

export async function getBuildingDetail(id: number): Promise<BuildingDetail | null> {
  const raw = await (async () => {
    const r = await viaDb(async () => {
      const rows = await q<{ doc: BuildingDetail }>(DETAIL_SQL, [id]);
      return rows[0]?.doc ?? null;
    });
    if (r.ok) return r.value;
    const all = await snapshot<Record<string, BuildingDetail>>('detail.json');
    return all[String(id)] ?? null;
  })();
  if (!raw) return null;

  // Same generator, same seeds and the same unit index getBuildings uses, so
  // the header rows the panel reads from the FeatureCollection and the rows it
  // reads from here can never disagree.
  const [units, streets, edit] = await Promise.all([
    unitIndex(), streetIndex(), editsFor(id),
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
    }),
    edit,
  );
  return { ...raw, building: { ...enriched, footprint: raw.building.footprint } };
}

/**
 * Every entity whose 3D volume contains (lon, lat, z), coarse to fine.
 * ST_3DIntersects against a POINT Z is the containment test on the DB path.
 */
export async function queryPoint(lon: number, lat: number, z: number): Promise<StackHit[]> {
  const hits = (await usingDb())
    ? await q<StackHit>(QUERY_SQL, [lon, lat, z])
    : await queryPointFromSnapshot(lon, lat, z);

  // The building label is built inside QUERY_SQL (and its JS twin), neither of
  // which can reach the TypeScript enrichment. Reconciled here so this third
  // read path names a building the same way the other two do.
  const named = await getBuildings();
  const byId = new Map(named.features.map((f) => [f.properties.id, f.properties]));
  return hits.map((h) => {
    const p = h.level === 'building' ? byId.get(h.id) : undefined;
    return p && p.name ? { ...h, label: p.name } : h;
  });
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
  lon: number,
  lat: number,
  z: number,
): Promise<StackHit[]> {
  const out: StackHit[] = [];
  const parcels = await snapshot<{ features: SnapParcel[] }>('parcels.json');
  const buildings = (await buildingsFC()) as unknown as { features: SnapBuilding[] };

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

    const detail = await getBuildingDetail(p.id);
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
