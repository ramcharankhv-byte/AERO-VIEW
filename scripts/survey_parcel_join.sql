-- Attach every building to the survey parcel it stands on.
--
-- SPLIT OUT OF scripts/survey_parcels.sql ON PURPOSE. It runs twice: once at
-- the end of the derived build, and again after
-- scripts/import_survey_parcels.py replaces the layer with an official one.
-- The alternative was a second copy of the join in the importer, and two
-- implementations of "which parcel is this building on" is exactly the kind of
-- pair that drifts and then disagrees on screen.
--
-- Reads its scope from seed_ctx, like every other SQL file here, so the caller
-- must have run project.make_seed_ctx() first.

\set ON_ERROR_STOP on
BEGIN;

-- Largest shared area, as the brief specifies. Materialised in UTM with a
-- spatial index on each side, because doing it with ST_Transform inline is a
-- transform per candidate pair and hyderabad-banjara has 2,213 buildings.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS sp_utm;
CREATE UNLOGGED TABLE sp_utm AS
SELECT id, ST_Transform(geom, 32644) AS g
  FROM survey_parcel WHERE project_id = (SELECT project_id FROM seed_ctx);
CREATE INDEX sp_utm_gix ON sp_utm USING gist (g);

DROP TABLE IF EXISTS b_utm;
CREATE UNLOGGED TABLE b_utm AS
SELECT id, ST_Transform(footprint, 32644) AS g
  FROM building WHERE project_id = (SELECT project_id FROM seed_ctx);
CREATE INDEX b_utm_gix ON b_utm USING gist (g);

UPDATE building SET survey_parcel_id = NULL
 WHERE project_id = (SELECT project_id FROM seed_ctx);

UPDATE building b SET survey_parcel_id = j.sp
  FROM (
    SELECT DISTINCT ON (bu.id) bu.id AS bid, su.id AS sp
      FROM b_utm bu JOIN sp_utm su ON ST_Intersects(bu.g, su.g)
     ORDER BY bu.id, ST_Area(ST_Intersection(bu.g, su.g)) DESC, su.id
  ) j
 WHERE b.id = j.bid;

-- The fallback, and it is a real case: a footprint OSM has drawn across a
-- street lies wholly inside a corridor and shares area with no parcel at all.
-- Nearest parcel by distance, rather than NULL. The parcels stay strictly
-- road-free -- unioning the footprint back in would have broken the clipping
-- guarantee to fix the join, which is the wrong way round -- so this building
-- is placed in the plot it is nearest to and the stage reports how many took
-- this path.
UPDATE building b SET survey_parcel_id = j.sp
  FROM (
    SELECT DISTINCT ON (bu.id) bu.id AS bid, su.id AS sp
      FROM b_utm bu
      JOIN building bb ON bb.id = bu.id AND bb.survey_parcel_id IS NULL
      CROSS JOIN LATERAL (
        SELECT s.id, s.g FROM sp_utm s ORDER BY s.g <-> bu.g LIMIT 1
      ) su
     ORDER BY bu.id
  ) j
 WHERE b.id = j.bid;

COMMIT;

\echo ''
\echo '--- building -> survey parcel ---'
SELECT
  (SELECT count(*) FROM building
    WHERE project_id = (SELECT project_id FROM seed_ctx)
      AND survey_parcel_id IS NOT NULL)                          AS buildings_joined,
  (SELECT count(*) FROM building
    WHERE project_id = (SELECT project_id FROM seed_ctx)
      AND survey_parcel_id IS NULL)                              AS buildings_unplaced,
  (SELECT round(min(extent_sqm)::numeric, 1) FROM survey_parcel
    WHERE project_id = (SELECT project_id FROM seed_ctx))        AS smallest_sqm,
  (SELECT round(avg(extent_sqm)::numeric, 1) FROM survey_parcel
    WHERE project_id = (SELECT project_id FROM seed_ctx))        AS mean_sqm;
