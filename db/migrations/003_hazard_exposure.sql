-- Migration 003 — derived local hazard exposure, for a volume that already
-- has data.
--
-- db/01_schema.sql carries these columns for a FRESH volume. Additive and
-- idempotent; it adds nullable columns and never rewrites a row.
--
--   docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
--     -f - < db/migrations/003_hazard_exposure.sql
--
-- These are DERIVED values (scripts/hazard.py), computed from the project's
-- CartoDEM surface and the coastline in the same tile. They are not a reading
-- of NRSC's flood or cyclone products, which are national-scale and return a
-- single polygon over an AOI of this size. NULL for a project with no DEM.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE building ADD COLUMN IF NOT EXISTS flood_risk     text;
ALTER TABLE building ADD COLUMN IF NOT EXISTS cyclone_risk   text;
ALTER TABLE building ADD COLUMN IF NOT EXISTS flood_score    double precision;
ALTER TABLE building ADD COLUMN IF NOT EXISTS cyclone_score  double precision;
ALTER TABLE building ADD COLUMN IF NOT EXISTS coast_dist_m   double precision;
ALTER TABLE building ADD COLUMN IF NOT EXISTS local_relief_m double precision;

DO $$
BEGIN
  ALTER TABLE building ADD CONSTRAINT building_flood_risk_check
    CHECK (flood_risk IN ('low','moderate','high','severe'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE building ADD CONSTRAINT building_cyclone_risk_check
    CHECK (cyclone_risk IN ('low','moderate','high','severe'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

COMMIT;
