-- Builds the cadastral stack from staged OSM data.
--
-- Runs AFTER 03_seed_db.py has populated stage_building(doc jsonb) and
-- stage_highway(doc jsonb). Deliberately NOT in db/, because everything in
-- that directory is executed by docker-entrypoint-initdb.d on a fresh volume,
-- when the staging tables do not yet exist.
--
-- All metric work happens in EPSG:32644 (UTM 44N). Results are transformed
-- back to 4326 for storage; ST_Transform leaves Z untouched, so the stored
-- solids are lon/lat degrees + height in metres, which is what Cesium wants.

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- Slice a footprint into an nx*ny grid of unit polygons.
--
-- The grid is aligned to the building's own orientation (via the minimum-area
-- oriented envelope) rather than to north, so units in a rotated block come out
-- as sensible rectangles instead of triangular slivers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION unit_cells(g geometry, nx int, ny int)
RETURNS SETOF geometry
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  ctr   geometry;
  env   geometry;
  ang   double precision;
  rot   geometry;
  x0 double precision; y0 double precision;
  x1 double precision; y1 double precision;
  i int; j int;
  cell geometry; piece geometry;
BEGIN
  IF g IS NULL OR ST_IsEmpty(g) THEN RETURN; END IF;
  ctr := ST_Centroid(g);
  env := ST_OrientedEnvelope(g);
  IF env IS NULL OR ST_GeometryType(env) <> 'ST_Polygon' THEN
    ang := 0;
  ELSE
    ang := ST_Azimuth(ST_PointN(ST_ExteriorRing(env), 1),
                      ST_PointN(ST_ExteriorRing(env), 2));
  END IF;

  rot := ST_Rotate(g, -ang, ctr);          -- axis-align the footprint
  x0 := ST_XMin(rot); y0 := ST_YMin(rot);
  x1 := ST_XMax(rot); y1 := ST_YMax(rot);

  FOR i IN 0 .. nx - 1 LOOP
    FOR j IN 0 .. ny - 1 LOOP
      cell := ST_MakeEnvelope(
        x0 + (x1 - x0) * i       / nx, y0 + (y1 - y0) * j       / ny,
        x0 + (x1 - x0) * (i + 1) / nx, y0 + (y1 - y0) * (j + 1) / ny,
        ST_SRID(g));
      piece := ST_CollectionExtract(ST_MakeValid(ST_Intersection(rot, cell)), 3);
      CONTINUE WHEN piece IS NULL OR ST_IsEmpty(piece) OR ST_Area(piece) < 4.0;
      SELECT d.geom INTO piece
        FROM (SELECT (ST_Dump(piece)).geom AS geom) d
       ORDER BY ST_Area(d.geom) DESC LIMIT 1;
      RETURN NEXT ST_Rotate(piece, ang, ctr);   -- rotate the cell back
    END LOOP;
  END LOOP;
END
$fn$;

-- Deterministic pseudo-random in [0,1) from a key, so re-seeding is stable.
CREATE OR REPLACE FUNCTION h01(key text) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT ('x' || substr(md5(key), 1, 8))::bit(32)::bigint::double precision / 4294967295.0;
$fn$;

-- ---------------------------------------------------------------------------
-- 1. Normalise staged buildings
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS b_norm;
CREATE UNLOGGED TABLE b_norm AS
SELECT
  (doc -> 'properties' ->> 'osm_id')::bigint            AS osm_id,
  doc -> 'properties'                                   AS props,
  ST_MakeValid(ST_Force2D(
    ST_SetSRID(ST_GeomFromGeoJSON(doc ->> 'geometry'), 4326)))  AS geom4326
FROM stage_building;

-- MakeValid can return collections; keep the largest polygon component.
UPDATE b_norm SET geom4326 = sub.geom
FROM (
  SELECT n.osm_id, d.geom
    FROM b_norm n,
         LATERAL (SELECT (ST_Dump(n.geom4326)).geom AS geom) d
   WHERE ST_GeometryType(d.geom) = 'ST_Polygon'
   ORDER BY n.osm_id, ST_Area(d.geom) DESC
) sub
WHERE sub.osm_id = b_norm.osm_id
  AND ST_GeometryType(b_norm.geom4326) <> 'ST_Polygon';

DELETE FROM b_norm WHERE ST_GeometryType(geom4326) <> 'ST_Polygon' OR ST_IsEmpty(geom4326);

ALTER TABLE b_norm ADD COLUMN geom_utm geometry;
UPDATE b_norm SET geom_utm = ST_Transform(geom4326, 32644);
DELETE FROM b_norm WHERE ST_Area(geom_utm) < 12;

-- ---------------------------------------------------------------------------
-- 2. Cluster buildings into parcels
--
-- A cadastral parcel routinely carries more than one structure (main house +
-- outbuilding, or a block of shops). DBSCAN at 18 m groups touching/adjacent
-- footprints into a single plot, so the parcel level is meaningful rather than
-- a 1:1 mirror of the building level.
-- ---------------------------------------------------------------------------
ALTER TABLE b_norm ADD COLUMN cluster_id int;
UPDATE b_norm SET cluster_id = c.cid
FROM (
  SELECT osm_id,
         ST_ClusterDBSCAN(ST_Centroid(geom_utm), eps := 18.0, minpoints := 1)
           OVER () AS cid
  FROM b_norm
) c
WHERE c.osm_id = b_norm.osm_id;

DROP TABLE IF EXISTS p_norm;
CREATE UNLOGGED TABLE p_norm AS
SELECT cluster_id,
       ST_Union(geom_utm)              AS blds_utm,
       ST_Centroid(ST_Union(geom_utm)) AS ctr_utm,
       NULL::geometry                  AS cell,
       NULL::geometry                  AS parcel_utm
FROM b_norm
GROUP BY cluster_id;

-- Voronoi cells over plot centroids give every parcel a boundary that never
-- overlaps its neighbour's -- the property a cadastre must have.
UPDATE p_norm SET cell = v.cell
FROM (
  SELECT (ST_Dump(
            ST_VoronoiPolygons(
              (SELECT ST_Collect(ctr_utm) FROM p_norm),
              0.0,
              (SELECT ST_Buffer(ST_Extent(blds_utm)::geometry, 120) FROM p_norm)
            ))).geom AS cell
) v
WHERE ST_Contains(v.cell, p_norm.ctr_utm);

-- Plot = the Voronoi cell, trimmed to a realistic curtilage around the built form.
UPDATE p_norm
   SET parcel_utm = ST_CollectionExtract(
         ST_MakeValid(ST_Intersection(COALESCE(cell, ST_Buffer(blds_utm, 7)),
                                      ST_Buffer(blds_utm, 7))), 3);

UPDATE p_norm SET parcel_utm = sub.geom
FROM (
  SELECT p.cluster_id, d.geom
    FROM p_norm p, LATERAL (SELECT (ST_Dump(p.parcel_utm)).geom AS geom) d
   ORDER BY p.cluster_id, ST_Area(d.geom) DESC
) sub
WHERE sub.cluster_id = p_norm.cluster_id
  AND ST_GeometryType(p_norm.parcel_utm) <> 'ST_Polygon';

DELETE FROM p_norm WHERE parcel_utm IS NULL OR ST_IsEmpty(parcel_utm)
   OR ST_GeometryType(parcel_utm) <> 'ST_Polygon';

-- ---------------------------------------------------------------------------
-- 3. parcel rows
--
-- Owner names are SYNTHETIC placeholders (see README). No real ownership data
-- is used anywhere in this project; the UI labels them as such.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS parcel_seq;
CREATE UNLOGGED TABLE parcel_seq AS
SELECT cluster_id,
       row_number() OVER (ORDER BY ST_YMax(parcel_utm) DESC, cluster_id)::int AS pid
FROM p_norm;

INSERT INTO parcel (id, ulpin, geom, area_m2, owner)
SELECT s.pid,
       ulpin_fmt(s.pid),
       ST_Transform(p.parcel_utm, 4326),
       round(ST_Area(p.parcel_utm)::numeric, 2),
       (ARRAY['A. Lakshmi','B. V. Ramana','CH. Padmavathi','D. Suryanarayana',
              'G. Satyavathi','K. Venkata Rao','M. Anjali','N. Prasad Reddy',
              'P. Sailaja','R. Gopalakrishna','S. Bhavani','T. Nageswara Rao',
              'V. Divya','Y. Ravi Kumar','Vizag Housing Co-op Society',
              'Andhra Estates Pvt Ltd'])[1 + floor(h01('own' || s.pid) * 16)::int]
FROM p_norm p JOIN parcel_seq s USING (cluster_id);

-- ---------------------------------------------------------------------------
-- 4. building rows
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS building_seq;
CREATE UNLOGGED TABLE building_seq AS
SELECT b.osm_id,
       s.pid,
       row_number() OVER (PARTITION BY s.pid ORDER BY ST_Area(b.geom_utm) DESC)::int AS bno,
       row_number() OVER (ORDER BY s.pid, ST_Area(b.geom_utm) DESC)::int             AS bid
FROM b_norm b JOIN parcel_seq s USING (cluster_id);

INSERT INTO building (id, parcel_id, ulpin, footprint, height_m, floors, basements,
                      ground_elev, use_type, height_source, survey_synthetic,
                      osm_id, name, address)
SELECT q.bid, q.pid, ulpin_fmt(q.pid, q.bno),
       b.geom4326,
       (b.props ->> 'height_m')::double precision,
       (b.props ->> 'floors')::int,
       (b.props ->> 'basements')::int,
       (b.props ->> 'ground_elev')::double precision,
       b.props ->> 'use_type',
       b.props ->> 'height_source',
       COALESCE((b.props ->> 'survey_synthetic')::boolean, false),
       b.osm_id,
       b.props ->> 'name',
       b.props ->> 'address'
FROM b_norm b JOIN building_seq q USING (osm_id);

-- ---------------------------------------------------------------------------
-- 5. floor rows -- one slab per level, basements below ground_elev
-- ---------------------------------------------------------------------------
INSERT INTO floor (id, building_id, ulpin, level_no, z_min, z_max, geom, detect_source)
SELECT row_number() OVER (ORDER BY b.id, lvl)::int,
       b.id,
       ulpin_fmt(b.parcel_id, bs.bno, lvl),
       lvl,
       b.ground_elev + lvl * 3.2,
       b.ground_elev + lvl * 3.2 + 3.2,
       make_prism(b.footprint, b.ground_elev + lvl * 3.2, b.ground_elev + lvl * 3.2 + 3.2),
       b.height_source
FROM building b
JOIN building_seq bs ON bs.bid = b.id
CROSS JOIN LATERAL generate_series(-b.basements, b.floors - 1) AS lvl
WHERE make_prism(b.footprint, b.ground_elev + lvl * 3.2, b.ground_elev + lvl * 3.2 + 3.2) IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. unit rows -- grid subdivision of the footprint, above-ground levels only
--    (basements are parking/plant, not separately titled units)
-- ---------------------------------------------------------------------------
WITH g AS (
  SELECT f.id AS floor_id, f.level_no, f.z_min, f.z_max,
         b.parcel_id AS pid, bs.bno,
         (row_number() OVER (PARTITION BY f.id))::int AS idx,
         c.cell
  FROM floor f
  JOIN building b     ON b.id = f.building_id
  JOIN building_seq bs ON bs.bid = b.id
  CROSS JOIN LATERAL unit_cells(
        ST_Transform(b.footprint, 32644),
        CASE WHEN b.use_type = 'residential' THEN 2 ELSE 3 END,
        CASE WHEN b.use_type = 'residential' THEN 2 ELSE 1 END) AS c(cell)
  WHERE f.level_no >= 0
),
g_prism AS (
  SELECT g.*,
         make_prism(ST_Transform(g.cell, 4326), g.z_min + 0.15, g.z_max - 0.35) AS geom_3d
  FROM g
)
INSERT INTO unit (id, floor_id, ulpin, unit_no, geom_3d, z_min, z_max,
                  carpet_m2, built_m2, tenure, encumbrance)
SELECT row_number() OVER (ORDER BY g.floor_id, g.idx)::int,
       g.floor_id,
       ulpin_fmt(g.pid, g.bno, g.level_no, g.idx),
       chr(65 + ((g.level_no)::int % 26)) || lpad(g.idx::text, 2, '0'),
       g.geom_3d,
       g.z_min + 0.15,
       g.z_max - 0.35,
       round((ST_Area(g.cell) * 0.78)::numeric, 2),
       round(ST_Area(g.cell)::numeric, 2),
       (ARRAY['Freehold','Freehold','Freehold','Leasehold','Rented','Co-operative'])
         [1 + floor(h01('ten' || g.floor_id || '-' || g.idx) * 6)::int],
       CASE WHEN h01('enc' || g.floor_id || '-' || g.idx) > 0.82
            THEN (ARRAY['Mortgage - SBI','Mortgage - HDFC Ltd','Lien - municipal dues',
                        'Disputed - civil suit pending'])
                   [1 + floor(h01('enk' || g.floor_id || '-' || g.idx) * 4)::int]
            ELSE 'None' END
FROM g_prism g
WHERE g.geom_3d IS NOT NULL;

COMMIT;

-- ---------------------------------------------------------------------------
ANALYZE parcel; ANALYZE building; ANALYZE floor; ANALYZE unit;

\echo '--- seed summary ---'
SELECT 'parcels'   AS entity, count(*) FROM parcel
UNION ALL SELECT 'buildings', count(*) FROM building
UNION ALL SELECT 'floors',    count(*) FROM floor
UNION ALL SELECT 'units',     count(*) FROM unit;

SELECT height_source, count(*) FROM building GROUP BY 1 ORDER BY 2 DESC;
