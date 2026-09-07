-- Builds the survey_parcel layer: the block share, clipped to the streets.
--
-- Runs AFTER build_geometry.sql (it reads `parcel` and `building` back out of
-- the database) and AFTER 03_seed_db.py has staged stage_highway and
-- stage_landuse. scripts/survey_parcels.py invokes it; scripts/seed.py places
-- that stage between `streets` and `export snapshots`.
--
-- Deliberately NOT in db/, because everything in that directory is executed by
-- docker-entrypoint-initdb.d on a fresh volume, when none of these tables have
-- rows yet.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS, AND WHAT IT IS NOT
--
-- It is NOT a survey. There is no official survey-parcel dataset for this area
-- of interest in this repository, and nothing here invents one: no survey
-- number, no TS number, no LPM number, no 14-digit Bhu-Aadhaar. Every row this
-- file writes carries provenance='derived', and the CHECK constraint on
-- survey_parcel makes it impossible for a derived row to carry any of those
-- columns. scripts/import_survey_parcels.py is the path a real register takes.
--
-- What it IS: a better-shaped derivation of the same plots `parcel` already
-- holds. `parcel` is the CURTILAGE -- the Voronoi cell trimmed to 7 m around
-- the built form -- which is right for showing which building stands on which
-- plot in 3D, and wrong for a cadastral sheet, because it leaves the land
-- between the buildings belonging to nobody. This layer keeps the whole
-- Voronoi cell and cuts the STREETS out of it instead, so the cells tile the
-- block the way a survey sheet does and no parcel crosses a road.
--
-- THE ORDINAL IS SHARED. Both layers derive from the same DBSCAN clusters, so
-- `survey_parcel.label` is the same 4-digit per-project ordinal that
-- `parcel.ulpin` ends in -- read straight off that identifier here, so the two
-- can never drift. AP-VSP-3D26-0042 names one plot whichever table you ask.
-- Dissolving a sliver retires its ordinal instead of renumbering the rest, so
-- the sequence has gaps. That is deliberate: renumbering would move every
-- identifier after the gap on the next re-seed.
--
-- All metric work happens in EPSG:32644 (UTM 44N), as everywhere else here,
-- and results are transformed back to 4326 for storage.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Project scope
--
-- Same two-numbers-per-row rule as build_geometry.sql: `label` is the ordinal
-- WITHIN the project and goes into the identifier; `id` is that ordinal's
-- position plus an offset past every other project's rows, because it is the
-- primary key building.survey_parcel_id and /api/.../survey-parcel/:id address
-- rows by.
--
-- DELETE, not TRUNCATE: truncating would erase a sibling AOI. The building FK
-- is ON DELETE SET NULL, so this also clears last run's join.
-- ---------------------------------------------------------------------------
DELETE FROM survey_parcel
 WHERE project_id = (SELECT project_id FROM seed_ctx);

ALTER TABLE seed_ctx ADD COLUMN IF NOT EXISTS survey_parcel_off int;
UPDATE seed_ctx
   SET survey_parcel_off = COALESCE((SELECT max(id) FROM survey_parcel), 0);

-- ---------------------------------------------------------------------------
-- 1. Seeds -- one point per existing parcel
--
-- The centroid of the parcel's BUILDINGS, not of the parcel polygon, because
-- that is the point build_geometry.sql built its Voronoi diagram from. Seeding
-- on anything else would produce cells that no longer correspond one-to-one
-- with the ordinals they are about to be labelled with.
--
-- LEFT JOIN with a fallback: a parcel with no buildings cannot arise from the
-- current build (clusters are made OF buildings), but a hand-loaded row could,
-- and silently dropping a plot is not a failure mode worth allowing.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS sp_seed;
CREATE UNLOGGED TABLE sp_seed AS
SELECT p.id                    AS parcel_id,
       right(p.ulpin, 4)       AS label,
       COALESCE(
         ST_Centroid(ST_Union(ST_Transform(b.footprint, 32644))),
         ST_Centroid(ST_Transform(p.geom, 32644))
       )                       AS ctr_utm
  FROM parcel p
  LEFT JOIN building b ON b.parcel_id = p.id
 WHERE p.project_id = (SELECT project_id FROM seed_ctx)
 GROUP BY p.id, p.ulpin, p.geom;

-- ---------------------------------------------------------------------------
-- 2. Voronoi cells, extended to the project's own bounding box
--
-- `extend_to` is the bbox rather than the extent of the buildings, so the
-- cells tile the whole area of interest instead of stopping at the last
-- footprint. That is the difference between a cadastral sheet and a scatter of
-- curtilages.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS sp_cell;
CREATE UNLOGGED TABLE sp_cell AS
SELECT s.parcel_id, s.label, s.ctr_utm,
       v.cell            AS cell,
       NULL::geometry    AS plot
  FROM sp_seed s
  JOIN (
    SELECT (ST_Dump(
              ST_VoronoiPolygons(
                (SELECT ST_Collect(ctr_utm) FROM sp_seed),
                0.0,
                (SELECT ST_Transform(bbox_geom, 32644)
                   FROM projects
                  WHERE id = (SELECT project_id FROM seed_ctx))
              ))).geom AS cell
  ) v ON ST_Contains(v.cell, s.ctr_utm);

-- Clip to the bbox itself. ST_VoronoiPolygons treats extend_to as a MINIMUM
-- extent and routinely returns cells well outside it; a parcel hanging past
-- the edge of the area of interest is land this project has no data about.
UPDATE sp_cell
   SET cell = ST_CollectionExtract(ST_MakeValid(ST_Intersection(
                cell,
                (SELECT ST_Transform(bbox_geom, 32644) FROM projects
                  WHERE id = (SELECT project_id FROM seed_ctx)))), 3);

-- ---------------------------------------------------------------------------
-- 3. Road corridors
--
-- THE WIDTHS BELOW ARE STATED TWICE. lib/roads/corridors.ts carries the same
-- table, because the unit test that asserts no parcel crosses a road runs in
-- Node over the exported GeoJSON and cannot ask PostGIS. lib/survey-parcel.test.ts
-- reads BOTH files and fails if they disagree -- the discipline lib/ulpin.test.ts
-- already applies to ulpin_fmt(). If you change a number here, change it there.
--
-- These are full corridor widths in metres, kerb to kerb plus verge, and each
-- centreline is buffered by HALF of its class's width on each side. They are
-- estimates of a typical Indian urban cross-section, not a survey of any
-- particular street -- which is one of the reasons every row here is `derived`.
--
-- The join is an INNER join, so a `highway` value not in this list (footway,
-- path, steps, construction) contributes no corridor. A pavement runs THROUGH
-- plots rather than between them; cutting parcels along footways would shred
-- them for no cadastral reason.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS sp_corridor;
CREATE UNLOGGED TABLE sp_corridor AS
SELECT ST_UnaryUnion(ST_Collect(
         ST_Buffer(
           ST_Transform(
             ST_SetSRID(ST_GeomFromGeoJSON(h.doc ->> 'geometry'), 4326), 32644),
           w.corridor_m / 2.0)
       )) AS corridor
  FROM stage_highway h
  JOIN (VALUES
          ('motorway',      24.0),
          ('trunk',         20.0),
          ('primary',       18.0),
          ('secondary',     14.0),
          ('tertiary',      11.0),
          ('residential',    8.0),
          ('unclassified',   8.0),
          ('living_street',  7.0),
          ('service',        5.0)
       ) AS w(cls, corridor_m)
    ON w.cls = h.doc -> 'properties' ->> 'highway';

-- ---------------------------------------------------------------------------
-- 4. Landuse areas
--
-- OPTIONAL. scripts/01_fetch_osm.py treats the landuse Overpass query as
-- non-fatal, so stage_landuse is legitimately empty on a project fetched
-- before this existed or seeded while Overpass was refusing. Empty means the
-- cells are clipped to road corridors alone, which is a coarser parcel layer
-- and not a wrong one. The stage prints which branch it took and the README
-- says so.
--
-- Two filters, both to stop a small area swallowing a whole plot:
--   * anything also tagged `building` is excluded -- an amenity tag on a
--     building way describes the building, not a parcel around it;
--   * anything under 400 m2 is excluded -- a restaurant or a parking bay is
--     not a block boundary, and intersecting a cell with one would leave a
--     parcel the size of a shop.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS sp_landuse;
CREATE UNLOGGED TABLE sp_landuse AS
SELECT ST_CollectionExtract(ST_MakeValid(
         ST_Transform(
           ST_SetSRID(ST_GeomFromGeoJSON(l.doc ->> 'geometry'), 4326), 32644)), 3)
         AS geom_utm
  FROM stage_landuse l
 WHERE l.doc -> 'properties' ->> 'building' IS NULL;

DELETE FROM sp_landuse
 WHERE geom_utm IS NULL OR ST_IsEmpty(geom_utm) OR ST_Area(geom_utm) < 400;

CREATE INDEX sp_landuse_gix ON sp_landuse USING gist (geom_utm);

-- ---------------------------------------------------------------------------
-- 5. The cut: cell -> landuse -> minus roads -> largest piece
-- ---------------------------------------------------------------------------

-- 5a. Landuse, where a seed sits inside one. The SMALLEST containing area
--     wins, because a school inside a residential landuse block should be
--     bounded by the school.
UPDATE sp_cell c
   SET plot = COALESCE(
     (SELECT ST_CollectionExtract(ST_MakeValid(
               ST_Intersection(c.cell, lu.geom_utm)), 3)
        FROM sp_landuse lu
       WHERE ST_Contains(lu.geom_utm, c.ctr_utm)
       ORDER BY ST_Area(lu.geom_utm) ASC
       LIMIT 1),
     c.cell);

-- A landuse area smaller than the built form inside it leaves a plot that no
-- longer holds its own buildings. Fall back to the unclipped cell there: the
-- refinement is worth having when it is right and never worth a wrong parcel.
UPDATE sp_cell SET plot = cell
 WHERE plot IS NULL OR ST_IsEmpty(plot) OR NOT ST_Intersects(plot, ctr_utm);

-- 5b. The streets come out. This is the assertion the unit test checks: after
--     this, no parcel polygon intersects a road corridor.
UPDATE sp_cell c
   SET plot = ST_CollectionExtract(ST_MakeValid(
                ST_Difference(c.plot, r.corridor)), 3)
  FROM sp_corridor r
 WHERE r.corridor IS NOT NULL;

-- 5c. A cell cut by a road running through it becomes several pieces. Keep the
--     largest, as build_geometry.sql does for a footprint -- DISTINCT ON, not
--     ORDER BY in a FROM clause, which PostgreSQL does not honour for the row
--     a join selects.
UPDATE sp_cell c SET plot = sub.geom
  FROM (
    SELECT DISTINCT ON (n.parcel_id) n.parcel_id, d.geom
      FROM sp_cell n, LATERAL (SELECT (ST_Dump(n.plot)).geom AS geom) d
     WHERE ST_GeometryType(d.geom) = 'ST_Polygon'
     ORDER BY n.parcel_id, ST_Area(d.geom) DESC
  ) sub
 WHERE sub.parcel_id = c.parcel_id
   AND ST_GeometryType(c.plot) <> 'ST_Polygon';

-- Anything with nothing left -- a plot that lay wholly under a corridor -- is
-- gone. Its ordinal is retired rather than reassigned; see the header.
DELETE FROM sp_cell
 WHERE plot IS NULL OR ST_IsEmpty(plot)
    OR ST_GeometryType(plot) <> 'ST_Polygon';

-- ---------------------------------------------------------------------------
-- 6. Dissolve slivers into their largest neighbour
--
-- 25 m2 is a 5 x 5 m square. Below that a cell is an artefact of two road
-- buffers meeting at an angle, not a plot. The threshold is also in
-- lib/roads/corridors.ts as SLIVER_MIN_SQM.
--
-- Bounded at three passes. A sliver merges into a NON-sliver neighbour, so one
-- pass clears almost all of them; the extra passes exist for a sliver whose
-- only neighbours were themselves slivers until the pass before. Anything
-- still under the threshold after three passes has no neighbour to merge into
-- -- an isolated fragment between two roads -- and is kept as the small plot
-- it genuinely is rather than deleted, because deleting it would lose land
-- that the streets do not account for.
-- ---------------------------------------------------------------------------
ALTER TABLE sp_cell ADD COLUMN merge_into int;

DO $$
DECLARE
  pass   int := 0;
  moved  int;
BEGIN
  LOOP
    pass := pass + 1;
    EXIT WHEN pass > 3;

    -- Who each sliver goes to. A NON-sliver neighbour only, so no target is
    -- itself about to be deleted; that is what makes a plain UPDATE safe here
    -- and why the loop needs more than one pass.
    UPDATE sp_cell s
       SET merge_into = (
         SELECT c.parcel_id
           FROM sp_cell c
          WHERE c.parcel_id <> s.parcel_id
            AND ST_Area(c.plot) >= 25.0
            AND ST_Intersects(c.plot, s.plot)
          ORDER BY ST_Length(ST_Intersection(ST_Boundary(c.plot),
                                             ST_Boundary(s.plot))) DESC,
                   ST_Area(c.plot) DESC,
                   c.parcel_id
          LIMIT 1)
     WHERE ST_Area(s.plot) < 25.0;

    GET DIAGNOSTICS moved = ROW_COUNT;
    EXIT WHEN moved = 0;

    -- One UNION per target, so two slivers meeting the same neighbour both
    -- land. ST_Union of polygons touching at a point yields a MultiPolygon;
    -- the largest piece is kept below, same rule as 5c.
    UPDATE sp_cell c
       SET plot = ST_CollectionExtract(ST_MakeValid(
                    ST_Union(c.plot, agg.add)), 3)
      FROM (SELECT merge_into AS nid, ST_Union(plot) AS add
              FROM sp_cell WHERE merge_into IS NOT NULL
             GROUP BY merge_into) agg
     WHERE c.parcel_id = agg.nid;

    UPDATE sp_cell c SET plot = sub.geom
      FROM (
        SELECT DISTINCT ON (n.parcel_id) n.parcel_id, d.geom
          FROM sp_cell n, LATERAL (SELECT (ST_Dump(n.plot)).geom AS geom) d
         WHERE ST_GeometryType(d.geom) = 'ST_Polygon'
         ORDER BY n.parcel_id, ST_Area(d.geom) DESC
      ) sub
     WHERE sub.parcel_id = c.parcel_id
       AND ST_GeometryType(c.plot) <> 'ST_Polygon';

    DELETE FROM sp_cell WHERE merge_into IS NOT NULL;
    UPDATE sp_cell SET merge_into = NULL WHERE merge_into IS NOT NULL;

    RAISE NOTICE 'survey_parcels: sliver pass %, % dissolved', pass, moved;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. survey_parcel rows
--
-- provenance='derived' and the five register columns left NULL, which the
-- CHECK constraint on the table also enforces. `label` ordering is
-- lexicographic over a zero-padded 4-digit string, which is numeric order, so
-- id assignment is deterministic across re-seeds.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS sp_seq;
CREATE UNLOGGED TABLE sp_seq AS
SELECT parcel_id, label, plot,
       (row_number() OVER (ORDER BY label)
          + (SELECT survey_parcel_off FROM seed_ctx))::int AS spid
  FROM sp_cell;

INSERT INTO survey_parcel (id, project_id, label, extent_sqm, provenance, geom)
SELECT s.spid,
       (SELECT project_id FROM seed_ctx),
       s.label,
       round(ST_Area(s.plot)::numeric, 2)::double precision,
       'derived',
       ST_Transform(s.plot, 4326)
  FROM sp_seq s;

COMMIT;

\echo ''
\echo '--- survey parcels built ---'
SELECT
  (SELECT count(*) FROM sp_seed)                                 AS seeds,
  (SELECT count(*) FROM sp_landuse)                              AS landuse_areas,
  (SELECT count(*) FROM survey_parcel
    WHERE project_id = (SELECT project_id FROM seed_ctx))         AS parcels,
  (SELECT round(min(extent_sqm)::numeric, 1) FROM survey_parcel
    WHERE project_id = (SELECT project_id FROM seed_ctx))         AS smallest_sqm,
  (SELECT round(avg(extent_sqm)::numeric, 1) FROM survey_parcel
    WHERE project_id = (SELECT project_id FROM seed_ctx))         AS mean_sqm;
