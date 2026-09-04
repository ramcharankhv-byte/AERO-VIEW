-- Underground utility corridors, offset laterally from OSM road centrelines,
-- plus 3D conflict detection against building basements.
--
-- Depths follow the brief: water -1.5 m, sewer -3.0 m, power -1.0 m, metro -14 m.
-- Each run is stored as a LineString Z centreline (drawn client-side as a
-- Cesium PolylineVolume) plus a solid `envelope_3d` corridor used for the
-- ST_3DIntersects test.

\set ON_ERROR_STOP on
BEGIN;

-- Scoped to one project, read from the seed_ctx row scripts/04_utilities.py
-- creates. DELETE rather than TRUNCATE, and only this project's rows: another
-- AOI's corridors and conflicts have nothing to do with this run, and
-- TRUNCATE cannot be told the difference.
--
-- Utility ids are offset past every other project's, for the same reason
-- build_geometry.sql offsets parcel and building ids: the id is a primary key
-- the API addresses rows by, so it stays globally unique even though the
-- corridors themselves are per project. The offset is taken after the delete,
-- so the first project seeded starts at 1 exactly as it always did.
DELETE FROM conflict c
 USING utility u
 WHERE c.a_type = 'utility' AND c.a_id = u.id
   AND u.project_id = (SELECT project_id FROM seed_ctx);
DELETE FROM utility WHERE project_id = (SELECT project_id FROM seed_ctx);

ALTER TABLE seed_ctx ADD COLUMN IF NOT EXISTS utility_off  int;
ALTER TABLE seed_ctx ADD COLUMN IF NOT EXISTS conflict_off int;
UPDATE seed_ctx SET
  utility_off  = COALESCE((SELECT max(id) FROM utility), 0),
  conflict_off = COALESCE((SELECT max(id) FROM conflict), 0);

-- Local ground datum. Every building in this AOI currently shares the default
-- 12.0 m (no DEM supplied), but averaging keeps this correct if one is added.
DROP TABLE IF EXISTS ground_ref;
CREATE UNLOGGED TABLE ground_ref AS
SELECT avg(ground_elev) AS z0 FROM building
 WHERE project_id = (SELECT project_id FROM seed_ctx);

-- ---------------------------------------------------------------------------
-- Road centrelines worth carrying services, in UTM so offsets are in metres.
-- Short driveways and footpaths are excluded: they would triple the tube count
-- without adding anything legible to the scene.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS road;
CREATE UNLOGGED TABLE road AS
SELECT (doc -> 'properties' ->> 'osm_id')::bigint AS osm_id,
       doc -> 'properties' ->> 'highway'          AS cls,
       ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(doc ->> 'geometry'), 4326),
                    32644)                        AS geom_utm
FROM stage_highway
WHERE doc -> 'properties' ->> 'highway' IN
      ('motorway','trunk','primary','secondary','tertiary',
       'residential','unclassified','living_street');

DELETE FROM road WHERE ST_Length(geom_utm) < 40;

-- ---------------------------------------------------------------------------
-- The longest LINESTRING component of a geometry, or NULL if it has none.
--
-- ST_OffsetCurve can return a MULTILINESTRING from a perfectly valid
-- LINESTRING: offsetting a hairpin or a tight loop makes the curve cross
-- itself and the result comes back as separate pieces. utility.geom_3d is
-- declared LineStringZ, so that is a hard insert failure --
--   ERROR: Geometry type (MultiLineString) does not match column type
--   (LineString)
-- -- and it aborts the whole transaction.
--
-- Siripuram's street network never triggered it, which is exactly why this was
-- not found until a second AOI was seeded. Taking the longest component is the
-- right answer rather than merely a safe one: the short pieces an offset
-- sheds are the inside of the hairpin, and a service corridor is laid along
-- the run of the road, not around the tightest part of its geometry.
CREATE OR REPLACE FUNCTION longest_line(g geometry)
RETURNS geometry
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT d.geom
    FROM (SELECT (ST_Dump(g)).geom AS geom) d
   WHERE ST_GeometryType(d.geom) = 'ST_LineString'
     AND ST_NPoints(d.geom) >= 2
   ORDER BY ST_Length(d.geom) DESC
   LIMIT 1;
$fn$;

-- ---------------------------------------------------------------------------
-- One run per (road, asset type). Lateral offset keeps services in their own
-- corridor instead of stacked on the centreline, which is how they are actually
-- laid: potable water and power on one verge, sewer on the other, metro deep
-- and central under the arterials only.
-- ---------------------------------------------------------------------------
INSERT INTO utility (id, project_id, asset_type, geom_3d, depth_m, radius_m,
                     authority, status)
SELECT (row_number() OVER (ORDER BY a.asset_type, r.osm_id)
          + (SELECT utility_off FROM seed_ctx))::int,
       (SELECT project_id FROM seed_ctx),
       a.asset_type,
       ST_Transform(
         ST_Force3D(
           COALESCE(longest_line(ST_OffsetCurve(ST_LineMerge(r.geom_utm), a.offset_m)),
                    r.geom_utm),
           (SELECT z0 FROM ground_ref) + a.depth_m),
         4326),
       a.depth_m,
       a.radius_m,
       a.authority,
       'operational'
FROM road r
JOIN (VALUES
        ('water', -1.5,  3.0, 0.25, 'GVMC Water Supply'),
        ('sewer', -3.0, -3.5, 0.40, 'GVMC Sewerage Board'),
        ('power', -1.0,  5.0, 0.20, 'APEPDCL'),
        ('metro', -14.0, 0.0, 3.20, 'Visakhapatnam Metro Rail Ltd')
     ) AS a(asset_type, depth_m, offset_m, radius_m, authority)
  ON (a.asset_type <> 'metro' OR r.cls IN ('motorway','trunk','primary','secondary'))
WHERE ST_GeometryType(ST_LineMerge(r.geom_utm)) = 'ST_LineString';

-- ---------------------------------------------------------------------------
-- DELIBERATE CONFLICT
--
-- The brief requires one sewer run driven straight through a building's
-- basement so the conflict check has something real to find. We pick a
-- basemented building near the middle of the AOI and lay a sewer across its
-- footprint at -3.0 m, which falls inside the B1 slab (ground-3.2 .. ground).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS victim;
CREATE UNLOGGED TABLE victim AS
SELECT b.id, b.ulpin, b.name, b.ground_elev,
       ST_Transform(b.footprint, 32644) AS fp_utm
FROM building b
WHERE b.basements >= 1
  AND b.project_id = (SELECT project_id FROM seed_ctx)
ORDER BY ST_Area(ST_Transform(b.footprint, 32644)) DESC
LIMIT 1;

INSERT INTO utility (id, project_id, asset_type, geom_3d, depth_m, radius_m,
                     authority, status)
SELECT (SELECT max(id) FROM utility) + 1,
       (SELECT project_id FROM seed_ctx),
       'sewer',
       ST_Transform(
         ST_Force3D(
           ST_MakeLine(
             ST_Translate(ST_Centroid(fp_utm), -1.2 * (ST_XMax(fp_utm) - ST_XMin(fp_utm)), 0),
             ST_Translate(ST_Centroid(fp_utm),  1.2 * (ST_XMax(fp_utm) - ST_XMin(fp_utm)), 0)),
           ground_elev - 3.0),
         4326),
       -3.0, 0.40, 'GVMC Sewerage Board', 'unauthorised alignment'
FROM victim;

-- ---------------------------------------------------------------------------
-- Solid corridor around each centreline, for the 3D test.
-- ---------------------------------------------------------------------------
UPDATE utility u
   SET envelope_3d = make_prism(
         ST_Transform(ST_Buffer(ST_Transform(u.geom_3d, 32644), u.radius_m), 4326),
         (SELECT z0 FROM ground_ref) + u.depth_m - u.radius_m,
         (SELECT z0 FROM ground_ref) + u.depth_m + u.radius_m)
 WHERE u.project_id = (SELECT project_id FROM seed_ctx);

-- ---------------------------------------------------------------------------
-- Conflicts: utility corridor vs basement slab.
-- The && prefilter uses the 2D GIST indexes; ST_3DIntersects (SFCGAL) then does
-- the exact test on the few surviving pairs. ST_MakeSolid matters: without it
-- both operands are mere surface shells, so a corridor lying wholly inside a
-- basement envelope -- the worst kind of encroachment -- would not be reported.
-- ---------------------------------------------------------------------------
-- Both sides are constrained to this project. The floor side goes through
-- building because floor has no project_id of its own -- it inherits one, and
-- inheriting it is the whole reason the column is not duplicated there.
-- conflict.id is assigned here rather than left to the serial, for the same
-- reason parcel and building ids are: it has to stay globally unique across
-- projects, and re-seeding must not walk it forward. The scoped DELETE above
-- cannot RESTART IDENTITY the way the old TRUNCATE did -- that would renumber
-- another AOI's conflicts -- so the offset does the same job safely, and for a
-- single-project database it is zero, which restores the original 1..n.
INSERT INTO conflict (id, a_id, a_type, b_id, b_type, kind)
SELECT (row_number() OVER (ORDER BY u.id, f.id)
          + (SELECT conflict_off FROM seed_ctx))::int,
       u.id, 'utility', f.id, 'floor', 'utility_through_basement'
FROM utility u
JOIN floor f
  ON f.level_no < 0
 AND f.geom && u.envelope_3d
JOIN building fb ON fb.id = f.building_id
WHERE u.envelope_3d IS NOT NULL
  AND u.project_id = (SELECT project_id FROM seed_ctx)
  AND fb.project_id = (SELECT project_id FROM seed_ctx)
  AND ST_3DIntersects(ST_MakeSolid(u.envelope_3d), ST_MakeSolid(f.geom));

-- Keep the serial ahead of the ids just written by hand, so anything that
-- later inserts without specifying one does not collide.
SELECT setval(pg_get_serial_sequence('conflict', 'id'),
              GREATEST((SELECT COALESCE(max(id), 0) FROM conflict), 1));

COMMIT;

ANALYZE utility; ANALYZE conflict;

\echo '--- utilities (this project) ---'
SELECT asset_type, count(*), round(min(depth_m)::numeric,1) AS depth_m
FROM utility
WHERE project_id = (SELECT project_id FROM seed_ctx)
GROUP BY 1 ORDER BY 1;

\echo '--- conflicts ---'
SELECT c.kind, u.asset_type, u.status, b.ulpin AS building_ulpin,
       f.level_no, f.ulpin AS floor_ulpin
FROM conflict c
JOIN utility u ON u.id = c.a_id
JOIN floor f   ON f.id = c.b_id
JOIN building b ON b.id = f.building_id
WHERE b.project_id = (SELECT project_id FROM seed_ctx)
ORDER BY c.id;
