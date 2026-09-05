-- 3D ULPIN — Vertical Property Mapper
-- LADM-inspired cadastral schema: parcel -> building -> floor -> unit,
-- plus underground utility corridors and the conflicts between them.
--
-- Geometry convention: everything is stored in EPSG:4326 with Z in METRES
-- above the WGS84 ellipsoid-ish local datum. Metric construction happens in
-- EPSG:32644 (UTM 44N) and is transformed back; ST_Transform leaves Z alone,
-- which is exactly the lon/lat/height triple CesiumJS consumes.

CREATE EXTENSION IF NOT EXISTS postgis;

-- SFCGAL powers ST_3DIntersects on solids. It is present in postgis/postgis
-- images, but the app must not hard-fail if it is not, so this is advisory:
-- lib/db + the conflict pass fall back to (2D intersect AND z-range overlap),
-- which is mathematically exact for the vertical prisms we generate.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS postgis_sfcgal;
  RAISE NOTICE 'postgis_sfcgal enabled';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'postgis_sfcgal unavailable (%), falling back to prism-exact 2D+Z conflict test', SQLERRM;
END
$$;

DROP TABLE IF EXISTS conflict, utility, unit, floor, building, parcel, projects CASCADE;

-- ---------------------------------------------------------------- projects
-- One AOI. Everything below is scoped to one of these.
--
-- Parcel NUMBERING is per project: the parcel numbered 0001 exists in every
-- project, and it is the state/district prefix in the ULPIN that keeps the
-- identifiers distinct. That is why state_code and district_code live here
-- rather than in a constant -- see ulpin_fmt() in 02_functions.sql and
-- lib/ulpin.ts, which mirror each other.
--
-- Row IDs are a different thing and stay globally unique, because they are the
-- primary keys the FKs and the API address rows by. scripts/build_geometry.sql
-- therefore computes two numbers per parcel: a per-project ordinal for the
-- ULPIN, and that ordinal plus an offset for the id. For the first project
-- seeded the offset is zero, which is what keeps siripuram's identifiers AND
-- its ids byte-identical to what they have always been.
--
-- floor and unit deliberately carry NO project_id. They reach one through
-- building, and duplicating it would create a second, de-normalised answer to
-- "which project is this floor in" that nothing enforces agreement between.
--
-- Named in the plural, unlike every other table here. That is the one place
-- this schema breaks its own convention, and it is deliberate: "project" is
-- also the name of the per-row concept threaded through the TypeScript, the
-- Python and the CLI, and having the table differ from the type by more than a
-- case fold makes every reference unambiguous.
CREATE TABLE projects (
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
  -- Entity counts, written by 05_export_static.py. Denormalised on purpose:
  -- the gallery renders one line of counts per card and must not run seven
  -- COUNT(*) queries per card -- nor need the database at all, since the
  -- committed data/api/projects.json carries the same numbers.
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- The demo AOI. Present from initdb so the pipeline has a project to seed into
-- and the gallery has a card before anything has been generated.
-- created_at is pinned rather than defaulted to now(): data/api/projects.json
-- is a committed snapshot of this row, and a value that changed with every
-- initdb would make the two disagree about the same project every time the
-- volume was rebuilt. The timestamp is when the demo AOI's data first entered
-- the repository.
INSERT INTO projects (slug, name, bbox_geom, state_code, district_code, status,
                      created_at)
VALUES ('siripuram', 'Siripuram, Visakhapatnam',
        ST_MakeEnvelope(83.3130, 17.7180, 83.3245, 17.7280, 4326),
        'AP', 'VSP', 'ready', '2026-09-01T04:49:47Z');

-- ---------------------------------------------------------------- parcel
CREATE TABLE parcel (
  id         integer PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ulpin      text UNIQUE NOT NULL,
  geom       geometry(Polygon, 4326) NOT NULL,
  area_m2    double precision NOT NULL,
  owner      text NOT NULL
);

-- ---------------------------------------------------------------- building
CREATE TABLE building (
  id            integer PRIMARY KEY,
  project_id    integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parcel_id     integer NOT NULL REFERENCES parcel(id) ON DELETE CASCADE,
  ulpin         text UNIQUE NOT NULL,
  footprint     geometry(Polygon, 4326) NOT NULL,
  height_m      double precision NOT NULL,
  floors        integer NOT NULL,
  basements     integer NOT NULL DEFAULT 0,
  ground_elev   double precision NOT NULL DEFAULT 12.0,
  use_type      text NOT NULL,
  -- provenance of height_m/floors. The whole point of the system is being
  -- able to tell a surveyed number from a guessed one.
  height_source text NOT NULL
                CHECK (height_source IN ('osm_tag','estimated','dsm_dem','surveyed_plan')),
  -- True when height_source='surveyed_plan' but the register that supplied it
  -- declared itself synthetic. Without this the UI would present fabricated
  -- demo data as an authoritative survey, which is the exact confusion this
  -- system exists to prevent.
  survey_synthetic boolean NOT NULL DEFAULT false,
  osm_id        bigint,
  name          text,
  address       text
);

-- ---------------------------------------------------------------- floor
CREATE TABLE floor (
  id            integer PRIMARY KEY,
  building_id   integer NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  ulpin         text UNIQUE NOT NULL,
  level_no      integer NOT NULL,          -- negative = basement, 0 = ground
  z_min         double precision NOT NULL,
  z_max         double precision NOT NULL,
  geom          geometry(PolyhedralSurfaceZ, 4326) NOT NULL,
  detect_source text NOT NULL
                CHECK (detect_source IN ('osm_tag','estimated','dsm_dem','surveyed_plan')),
  UNIQUE (building_id, level_no)
);

-- ---------------------------------------------------------------- unit
CREATE TABLE unit (
  id          integer PRIMARY KEY,
  floor_id    integer NOT NULL REFERENCES floor(id) ON DELETE CASCADE,
  ulpin       text UNIQUE NOT NULL,
  unit_no     text NOT NULL,
  geom_3d     geometry(PolyhedralSurfaceZ, 4326) NOT NULL,
  z_min       double precision NOT NULL,
  z_max       double precision NOT NULL,
  carpet_m2   double precision NOT NULL,
  built_m2    double precision NOT NULL,
  tenure      text NOT NULL,               -- Freehold / Leasehold / Rented / Co-operative
  encumbrance text NOT NULL DEFAULT 'None',
  -- Who holds the flat, where it is, which way it looks.
  --
  -- Nullable, unlike every column above, because only a surveyed building
  -- has them: the OSM-derived stock has no per-unit register behind it, and
  -- a NOT NULL default would turn "we do not know" into a fact on screen.
  -- The viewer shows a flat with no owner as unknown rather than falling
  -- back to the parcel's owner, which would attribute every flat in a tower
  -- to its developer.
  owner       text,
  address     text,
  facing      text
);

-- ---------------------------------------------------------------- utility
CREATE TABLE utility (
  id          integer PRIMARY KEY,
  project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_type  text NOT NULL CHECK (asset_type IN ('water','sewer','power','metro')),
  geom_3d     geometry(LineStringZ, 4326) NOT NULL,  -- centreline, drawn as a PolylineVolume
  envelope_3d geometry(PolyhedralSurfaceZ, 4326),    -- solid corridor, used for 3D conflict tests
  depth_m     double precision NOT NULL,             -- negative = below ground
  radius_m    double precision NOT NULL,
  authority   text NOT NULL,
  status      text NOT NULL DEFAULT 'operational'
);

-- ---------------------------------------------------------------- conflict
CREATE TABLE conflict (
  id          serial PRIMARY KEY,
  a_id        integer NOT NULL,
  a_type      text    NOT NULL,
  b_id        integer NOT NULL,
  b_type      text    NOT NULL,
  kind        text    NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- indexes
CREATE INDEX projects_bbox_gix  ON projects USING gist (bbox_geom);
CREATE INDEX parcel_geom_gix    ON parcel   USING gist (geom);
CREATE INDEX parcel_project_ix  ON parcel   (project_id);
CREATE INDEX building_project_ix ON building (project_id);
CREATE INDEX utility_project_ix ON utility  (project_id);
CREATE INDEX building_fp_gix    ON building USING gist (footprint);
CREATE INDEX building_parcel_ix ON building (parcel_id);
CREATE INDEX floor_geom_gix     ON floor    USING gist (geom);
CREATE INDEX floor_building_ix  ON floor    (building_id);
CREATE INDEX unit_geom_gix      ON unit     USING gist (geom_3d);
CREATE INDEX unit_floor_ix      ON unit     (floor_id);
CREATE INDEX utility_geom_gix   ON utility  USING gist (geom_3d);
CREATE INDEX utility_env_gix    ON utility  USING gist (envelope_3d);
