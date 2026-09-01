import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type { BuildingDetail, ConflictRow, StackHit } from './types';

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
      max: 4,
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

export async function getBuildings(): Promise<unknown> {
  if (await usingDb()) return (await q<{ fc: unknown }>(BUILDINGS_SQL))[0].fc;
  return snapshot('buildings.json');
}

export async function getParcels(): Promise<unknown> {
  if (await usingDb()) return (await q<{ fc: unknown }>(PARCELS_SQL))[0].fc;
  return snapshot('parcels.json');
}

export async function getUtilities(): Promise<unknown> {
  if (await usingDb()) return (await q<{ fc: unknown }>(UTILITIES_SQL))[0].fc;
  return snapshot('utilities.json');
}

export async function getConflicts(): Promise<ConflictRow[]> {
  if (await usingDb()) {
    return (await q<{ rows: ConflictRow[] }>(CONFLICTS_SQL))[0].rows;
  }
  return snapshot<ConflictRow[]>('conflicts.json');
}

export async function getBuildingDetail(id: number): Promise<BuildingDetail | null> {
  if (await usingDb()) {
    const rows = await q<{ doc: BuildingDetail }>(DETAIL_SQL, [id]);
    return rows[0]?.doc ?? null;
  }
  const all = await snapshot<Record<string, BuildingDetail>>('detail.json');
  return all[String(id)] ?? null;
}

/**
 * Every entity whose 3D volume contains (lon, lat, z), coarse to fine.
 * ST_3DIntersects against a POINT Z is the containment test on the DB path.
 */
export async function queryPoint(lon: number, lat: number, z: number): Promise<StackHit[]> {
  if (await usingDb()) return q<StackHit>(QUERY_SQL, [lon, lat, z]);
  return queryPointFromSnapshot(lon, lat, z);
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
  const buildings = await snapshot<{ features: SnapBuilding[] }>('buildings.json');

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
