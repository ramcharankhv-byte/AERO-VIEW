-- Migration 001 — multi-project support, for a volume that already has data.
--
-- db/01_schema.sql is run by docker-entrypoint-initdb.d on a FRESH volume and
-- already contains everything below. This file exists for the other case: an
-- existing ulpin_pgdata volume holding a seeded siripuram that you do not want
-- to drop and re-seed. It is additive and idempotent, and it never drops a
-- table or deletes a row.
--
--   docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
--     -f - < db/migrations/001_multi_project.sql
--
-- Running it twice is a no-op. Running it on a fresh volume is also a no-op.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  id            serial PRIMARY KEY,
  slug          text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name          text NOT NULL,
  bbox_geom     geometry(Polygon, 4326) NOT NULL,
  state_code    text NOT NULL,
  district_code text NOT NULL,
  scheme_code   text NOT NULL DEFAULT '3D26',
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','generating','ready','failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS projects_bbox_gix ON projects USING gist (bbox_geom);

-- The demo AOI. ON CONFLICT DO NOTHING so re-running never rewrites a row the
-- pipeline has since updated with real stats.
INSERT INTO projects (slug, name, bbox_geom, state_code, district_code, status,
                      created_at)
VALUES ('siripuram', 'Siripuram, Visakhapatnam',
        ST_MakeEnvelope(83.3130, 17.7180, 83.3245, 17.7280, 4326),
        'AP', 'VSP', 'ready', '2026-09-01T04:49:47Z')
ON CONFLICT (slug) DO NOTHING;

-- Scoping columns. Nullable first, so the backfill below has something to do.
ALTER TABLE parcel   ADD COLUMN IF NOT EXISTS project_id integer;
ALTER TABLE building ADD COLUMN IF NOT EXISTS project_id integer;
ALTER TABLE utility  ADD COLUMN IF NOT EXISTS project_id integer;

-- Backfill: every row that predates this migration is siripuram, because
-- siripuram is the only AOI this application has ever held.
UPDATE parcel   SET project_id = (SELECT id FROM projects WHERE slug = 'siripuram')
 WHERE project_id IS NULL;
UPDATE building SET project_id = (SELECT id FROM projects WHERE slug = 'siripuram')
 WHERE project_id IS NULL;
UPDATE utility  SET project_id = (SELECT id FROM projects WHERE slug = 'siripuram')
 WHERE project_id IS NULL;

-- Only now can the constraints go on.
DO $$
BEGIN
  ALTER TABLE parcel   ALTER COLUMN project_id SET NOT NULL;
  ALTER TABLE building ALTER COLUMN project_id SET NOT NULL;
  ALTER TABLE utility  ALTER COLUMN project_id SET NOT NULL;
EXCEPTION WHEN OTHERS THEN
  -- An empty database has nothing to backfill and nothing to constrain
  -- against; leaving the columns nullable there is harmless because
  -- build_geometry.sql always writes them.
  RAISE NOTICE 'project_id left nullable (%)', SQLERRM;
END
$$;

DO $$
BEGIN
  ALTER TABLE parcel   ADD CONSTRAINT parcel_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
DO $$
BEGIN
  ALTER TABLE building ADD CONSTRAINT building_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
DO $$
BEGIN
  ALTER TABLE utility  ADD CONSTRAINT utility_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS parcel_project_ix   ON parcel   (project_id);
CREATE INDEX IF NOT EXISTS building_project_ix ON building (project_id);
CREATE INDEX IF NOT EXISTS utility_project_ix  ON utility  (project_id);

COMMIT;

\echo '--- migration 001 applied ---'
SELECT p.slug, p.status,
       (SELECT count(*) FROM parcel   WHERE project_id = p.id) AS parcels,
       (SELECT count(*) FROM building WHERE project_id = p.id) AS buildings,
       (SELECT count(*) FROM utility  WHERE project_id = p.id) AS utilities
  FROM projects p ORDER BY p.id;
