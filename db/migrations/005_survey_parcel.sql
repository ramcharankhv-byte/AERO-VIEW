-- Migration 005 — the survey_parcel layer, for a volume that already has data.
--
-- db/01_schema.sql is run by docker-entrypoint-initdb.d on a FRESH volume and
-- already contains everything below. This file exists for the other case: an
-- existing ulpin_pgdata volume you do not want to drop and re-seed. It is
-- additive and idempotent, and it never drops a table or deletes a row.
--
--   docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
--     -f - < db/migrations/005_survey_parcel.sql
--
-- Running it twice is a no-op. Running it on a fresh volume is also a no-op.
--
-- NOTE ON THE NUMBER. The task this was written for asks for
-- `002_survey_parcel.sql`. 002, 003 and 004 were already taken
-- (002_cartodem_bhuvan, 003_hazard_exposure, 004_utility_categories), so this
-- is 005. Migrations are applied in filename order and reusing 002 would put
-- this table before the columns it has nothing to do with.
--
-- It adds no rows. The table is populated by scripts/survey_parcels.sql, which
-- runs as a seed stage; until a seed runs, `survey_parcel` is empty and
-- `building.survey_parcel_id` is NULL everywhere, which is exactly what the
-- application already handles (the layer draws nothing and the API serves the
-- committed snapshot).

\set ON_ERROR_STOP on
BEGIN;

-- See db/01_schema.sql for what each column is for and why five of them are
-- empty. The short version: 'derived' rows are generated from OpenStreetMap
-- and are not survey numbers; ts_no / lpm_no / ulpin_14 / source / source_date
-- exist so that a real register is an import rather than a schema change.
CREATE TABLE IF NOT EXISTS survey_parcel (
  id             integer PRIMARY KEY,
  project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label          text NOT NULL,
  ts_no          text,
  lpm_no         text,
  ulpin_14       text,
  extent_sqm     double precision NOT NULL,
  classification text,
  provenance     text NOT NULL DEFAULT 'derived'
                 CHECK (provenance IN ('derived','survey_dept')),
  source         text,
  source_date    date,
  geom           geometry(Polygon, 4326) NOT NULL,
  UNIQUE (project_id, label),
  CONSTRAINT survey_parcel_provenance_ck CHECK (
    (provenance = 'derived'
       AND ts_no IS NULL AND lpm_no IS NULL AND ulpin_14 IS NULL
       AND source IS NULL AND source_date IS NULL)
    OR (provenance = 'survey_dept' AND source IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS survey_parcel_geom_gix
  ON survey_parcel USING gist (geom);
CREATE INDEX IF NOT EXISTS survey_parcel_project_ix
  ON survey_parcel (project_id);

-- Nullable, and it stays nullable: a building the join cannot place must read
-- as unplaced rather than as placed somewhere arbitrary. There is nothing to
-- backfill -- the column is populated by the seed stage, not by this file.
ALTER TABLE building ADD COLUMN IF NOT EXISTS survey_parcel_id integer;

DO $$
BEGIN
  ALTER TABLE building ADD CONSTRAINT building_survey_parcel_fk
    FOREIGN KEY (survey_parcel_id) REFERENCES survey_parcel(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS building_survey_parcel_ix
  ON building (survey_parcel_id);

COMMIT;

\echo '--- migration 005 applied ---'
SELECT p.slug,
       (SELECT count(*) FROM survey_parcel WHERE project_id = p.id)
         AS survey_parcels,
       (SELECT count(*) FROM building
         WHERE project_id = p.id AND survey_parcel_id IS NOT NULL)
         AS buildings_joined
  FROM projects p ORDER BY p.id;
