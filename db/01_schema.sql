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

DROP TABLE IF EXISTS conflict, utility, unit, floor, building, parcel CASCADE;

-- ---------------------------------------------------------------- parcel
CREATE TABLE parcel (
  id       integer PRIMARY KEY,
  ulpin    text UNIQUE NOT NULL,
  geom     geometry(Polygon, 4326) NOT NULL,
  area_m2  double precision NOT NULL,
  owner    text NOT NULL
);

-- ---------------------------------------------------------------- building
CREATE TABLE building (
  id            integer PRIMARY KEY,
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
  encumbrance text NOT NULL DEFAULT 'None'
);

-- ---------------------------------------------------------------- utility
CREATE TABLE utility (
  id          integer PRIMARY KEY,
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
CREATE INDEX parcel_geom_gix    ON parcel   USING gist (geom);
CREATE INDEX building_fp_gix    ON building USING gist (footprint);
CREATE INDEX building_parcel_ix ON building (parcel_id);
CREATE INDEX floor_geom_gix     ON floor    USING gist (geom);
CREATE INDEX floor_building_ix  ON floor    (building_id);
CREATE INDEX unit_geom_gix      ON unit     USING gist (geom_3d);
CREATE INDEX unit_floor_ix      ON unit     (floor_id);
CREATE INDEX utility_geom_gix   ON utility  USING gist (geom_3d);
CREATE INDEX utility_env_gix    ON utility  USING gist (envelope_3d);
