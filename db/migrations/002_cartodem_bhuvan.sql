-- Migration 002 — CartoDEM ground-elevation provenance + Bhuvan overlays, for
-- a volume that already has data.
--
-- db/01_schema.sql already contains these columns for a FRESH volume. This
-- file is for an existing ulpin_pgdata volume. Additive and idempotent: it
-- adds columns with defaults and never drops or rewrites a row.
--
--   docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
--     -f - < db/migrations/002_cartodem_bhuvan.sql
--
-- The seeding pipeline REQUIRES this migration from now on: scripts/project.py
-- writes projects.bhuvan_layers / elev_source / elev_datum, and
-- scripts/build_geometry.sql writes building.ground_source.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS elev_source text NOT NULL DEFAULT 'placeholder';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS elev_datum  text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS bhuvan_layers jsonb;

DO $$
BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_elev_source_check
    CHECK (elev_source IN ('cartodem_v3','placeholder'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

-- Every building row that predates this migration carries the 12.0 m
-- placeholder, which is exactly what the default says.
ALTER TABLE building ADD COLUMN IF NOT EXISTS ground_source text NOT NULL DEFAULT 'placeholder';

DO $$
BEGIN
  ALTER TABLE building ADD CONSTRAINT building_ground_source_check
    CHECK (ground_source IN ('dsm_dem','placeholder'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

COMMIT;
