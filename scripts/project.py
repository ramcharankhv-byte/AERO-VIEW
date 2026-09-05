"""Project resolution for the seeding pipeline.

One AOI is one project. Every script in scripts/ takes the same arguments and
resolves them through here, so "which AOI am I building" is answered once
rather than five times:

    python scripts/03_seed_db.py --slug=hyderabad-banjara \\
        --name="Banjara Hills Ward" --bbox=78.4300,17.4100,78.4450,17.4250 \\
        --state=TS --district=HYD

With NO arguments this resolves to siripuram, with the same bbox, the same
codes and -- importantly -- the same file paths it has always used. That is
what makes `npm run seed` with no arguments reproduce today's numbers rather
than merely something similar.

Paths are the one place the demo project is deliberately special-cased. Its raw
OSM extract is committed at data/raw_buildings.geojson and data/
raw_highways.geojson and predates this feature; moving it would be a rename of
committed data for no gain. Every other project keeps its inputs under
data/projects/<slug>/, alongside the raw Overpass response the fetch caches.
"""
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
DATA = os.path.join(ROOT, "data")

DEFAULT_SLUG = "siripuram"

# The demo AOI. These are the values db/01_schema.sql inserts, restated here so
# the pipeline can run against a database that has not been migrated yet.
DEFAULT = {
    "slug": DEFAULT_SLUG,
    "name": "Siripuram, Visakhapatnam",
    "bbox": (83.3130, 17.7180, 83.3245, 17.7280),
    "state": "AP",
    "district": "VSP",
    "scheme": "3D26",
}

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

# Guard rails on the bbox. Both exist because Overpass is a shared public
# service and a fat-fingered coordinate is the easy way to ask it for a
# continent: the failure is not ours to absorb.
MAX_AREA_KM2 = 4.0
MAX_ASPECT = 3.0

M_PER_DEG_LAT = 110574.0

DEFAULT_GROUND_ELEV = 12.0
FLOOR_HEIGHT = 3.2

# ISRO Bhuvan WMS context overlays, per project. Optional: a project with no
# entry here offers no "Context (ISRO)" group in the viewer. Layer names are
# the WMS <Name>s on https://bhuvan-vec2.nrsc.gov.in/bhuvan/ows. Written into
# projects.bhuvan_layers by upsert_row() and exported to data/api/projects.json.
BHUVAN_LAYERS = {
    "siripuram": {
        "lulc": "sisdpv2:AP_Visakhapatnam_lulc_v2",
        "flood": "school:school_flood_hazard_zone",
        "cyclone": "school:school_tropical_cyclone_hazard_zones",
    },
}


class ArgError(SystemExit):
    """A bad invocation. Carries a message and a non-zero exit status."""

    def __init__(self, message):
        super().__init__(f"seed: {message}")


class Project:
    """One AOI, plus every path and constant derived from it."""

    def __init__(self, slug, name, bbox, state, district, scheme="3D26"):
        self.slug = slug
        self.name = name
        self.bbox = tuple(float(v) for v in bbox)
        self.state = state
        self.district = district
        self.scheme = scheme

        self.west, self.south, self.east, self.north = self.bbox
        self.lat0 = (self.south + self.north) / 2.0
        self.lon0 = (self.west + self.east) / 2.0
        # An equirectangular projection anchored at the AOI centre is accurate
        # to well under a metre over a bbox this small -- fine for the area and
        # height heuristics in 02_heights.py. All *authoritative* metric
        # geometry is still built in EPSG:32644 inside PostGIS.
        self.m_per_deg_lon = 111320.0 * math.cos(math.radians(self.lat0))

    # ---------------------------------------------------------------- geometry
    @property
    def overpass_bbox(self):
        """Overpass wants (south, west, north, east)."""
        return f"{self.south},{self.west},{self.north},{self.east}"

    @property
    def width_m(self):
        return abs(self.east - self.west) * self.m_per_deg_lon

    @property
    def height_m(self):
        return abs(self.north - self.south) * M_PER_DEG_LAT

    @property
    def area_km2(self):
        return (self.width_m * self.height_m) / 1e6

    @property
    def aspect(self):
        lo = min(self.width_m, self.height_m)
        return (max(self.width_m, self.height_m) / lo) if lo > 0 else float("inf")

    def to_local(self, lon, lat):
        """lon/lat degrees -> metres east/north of the AOI centre."""
        return ((lon - self.lon0) * self.m_per_deg_lon,
                (lat - self.lat0) * M_PER_DEG_LAT)

    def ring_area_m2(self, coords):
        """Shoelace area in m^2 for a lon/lat ring."""
        pts = [self.to_local(x, y) for x, y in coords]
        if len(pts) < 3:
            return 0.0
        s = 0.0
        for i in range(len(pts) - 1):
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            s += x1 * y2 - x2 * y1
        # close the ring if the source did not
        if pts[0] != pts[-1]:
            x1, y1 = pts[-1]
            x2, y2 = pts[0]
            s += x1 * y2 - x2 * y1
        return abs(s) / 2.0

    # ------------------------------------------------------------------- paths
    @property
    def is_default(self):
        return self.slug == DEFAULT_SLUG

    @property
    def work_dir(self):
        """Where this project's inputs and caches live."""
        return DATA if self.is_default else os.path.join(DATA, "projects", self.slug)

    @property
    def api_dir(self):
        return os.path.join(DATA, "api", self.slug)

    @property
    def raw_buildings_path(self):
        return os.path.join(self.work_dir, "raw_buildings.geojson")

    @property
    def raw_highways_path(self):
        return os.path.join(self.work_dir, "raw_highways.geojson")

    @property
    def attributed_path(self):
        return os.path.join(self.work_dir, "buildings_attributed.geojson")

    @property
    def osm_cache_path(self):
        """The raw Overpass responses, exactly as returned.

        Kept so a re-run never has to ask Overpass again, and so a question
        about what the pipeline was given has an answer that is not a
        transformed derivative.
        """
        return os.path.join(self.work_dir, "osm.json")

    # ---------------------------------------------------------------- DEM
    # The DEM is NOT special-cased for the demo project: data/projects/<slug>/
    # for everyone, including siripuram, whose raw CartoDEM tile was placed
    # there. dem_raw.tif is the untouched NRSC tile (ignored by git);
    # dem.tif is the bbox clip scripts/dem.py writes (small, committed).
    @property
    def dem_dir(self):
        return os.path.join(DATA, "projects", self.slug)

    @property
    def dem_raw_path(self):
        """The raw tile, or None. Accepts dem_raw.tif or the NRSC file name."""
        canonical = os.path.join(self.dem_dir, "dem_raw.tif")
        if os.path.exists(canonical):
            return canonical
        if os.path.isdir(self.dem_dir):
            for name in sorted(os.listdir(self.dem_dir)):
                if "_DEM_" in name and name.lower().endswith(".tif"):
                    return os.path.join(self.dem_dir, name)
        return None

    @property
    def dem_path(self):
        return os.path.join(self.dem_dir, "dem.tif")

    @property
    def global_dem_path(self):
        """The pre-multi-project fallback, data/dem.tif, if someone drops one in."""
        return os.path.join(DATA, "dem.tif")

    @property
    def bhuvan_layers(self):
        return BHUVAN_LAYERS.get(self.slug)

    def ensure_dirs(self):
        os.makedirs(self.work_dir, exist_ok=True)
        os.makedirs(self.api_dir, exist_ok=True)

    def describe(self):
        return (f"{self.slug} — {self.name}  bbox={self.bbox}  "
                f"{self.state}/{self.district}/{self.scheme}  "
                f"{self.width_m / 1000:.2f} x {self.height_m / 1000:.2f} km "
                f"({self.area_km2:.2f} km2)")


def default_project():
    return Project(**DEFAULT)


def _parse_bbox(raw):
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise ArgError(
            f"--bbox needs four comma-separated numbers "
            f"(west,south,east,north); got {len(parts)}: {raw!r}")
    try:
        west, south, east, north = (float(p) for p in parts)
    except ValueError:
        raise ArgError(f"--bbox coordinates must all be numbers; got {raw!r}")
    if not (-180 <= west <= 180 and -180 <= east <= 180):
        raise ArgError(f"--bbox longitudes must be within -180..180; got {west},{east}")
    if not (-90 <= south <= 90 and -90 <= north <= 90):
        raise ArgError(f"--bbox latitudes must be within -90..90; got {south},{north}")
    if west >= east:
        raise ArgError(f"--bbox west ({west}) must be less than east ({east})")
    if south >= north:
        raise ArgError(f"--bbox south ({south}) must be less than north ({north})")
    return (west, south, east, north)


def validate(project):
    """Reject an AOI at entry rather than after a five-minute Overpass wait."""
    if not SLUG_RE.match(project.slug):
        raise ArgError(
            f"--slug must be lower-case letters, digits and hyphens, starting "
            f"with a letter or digit, at most 64 characters; got {project.slug!r}")
    if not project.name.strip():
        raise ArgError("--name must not be empty")
    if not re.match(r"^[A-Z]{2}$", project.state):
        raise ArgError(f"--state must be a two-letter code, e.g. AP; got {project.state!r}")
    if not re.match(r"^[A-Z]{2,4}$", project.district):
        raise ArgError(
            f"--district must be a two-to-four-letter code, e.g. VSP; "
            f"got {project.district!r}")
    if project.area_km2 > MAX_AREA_KM2:
        raise ArgError(
            f"--bbox covers {project.area_km2:.2f} km2, over the {MAX_AREA_KM2} km2 "
            f"limit. This pipeline extrudes every building into floors and units "
            f"and subdivides every floor into flats; an AOI this size is a very "
            f"long seed and an Overpass query it is not polite to send. Split it.")
    if project.aspect > MAX_ASPECT:
        raise ArgError(
            f"--bbox is {project.aspect:.1f}:1, over the {MAX_ASPECT}:1 limit "
            f"({project.width_m:.0f} x {project.height_m:.0f} m). A sliver that "
            f"shape usually means two coordinates were transposed; if it is "
            f"really the corridor you want, seed it as two projects.")
    return project


def parse_args(argv=None):
    """Resolve a Project from the command line. No arguments -> siripuram."""
    argv = list(sys.argv[1:] if argv is None else argv)
    opts = {}
    for arg in argv:
        if not arg.startswith("--"):
            continue
        if "=" in arg:
            key, _, value = arg[2:].partition("=")
            opts[key.strip()] = value
        else:
            opts[arg[2:].strip()] = True

    known = {"slug", "name", "bbox", "state", "district", "scheme", "force"}
    unknown = sorted(set(opts) - known)
    if unknown:
        raise ArgError(
            f"unrecognised option(s): {', '.join('--' + u for u in unknown)}. "
            f"Known: {', '.join('--' + k for k in sorted(known))}")

    # No project arguments at all is the demo project, unchanged in every
    # respect including its file paths.
    if not (set(opts) - {"force"}):
        return default_project()

    missing = [k for k in ("slug", "name", "bbox") if not isinstance(opts.get(k), str)]
    if missing:
        raise ArgError(
            f"missing required option(s): {', '.join('--' + m for m in missing)}. "
            f"A new project needs at least --slug, --name and --bbox; --state and "
            f"--district default to AP/VSP, which is almost certainly wrong for "
            f"an AOI outside Visakhapatnam.")

    project = Project(
        slug=opts["slug"].strip().lower(),
        name=opts["name"].strip(),
        bbox=_parse_bbox(opts["bbox"]),
        state=str(opts.get("state", DEFAULT["state"])).strip().upper(),
        district=str(opts.get("district", DEFAULT["district"])).strip().upper(),
        scheme=str(opts.get("scheme", DEFAULT["scheme"])).strip().upper(),
    )
    return validate(project)


# ---------------------------------------------------------------------------
# The database side: the projects row, and the seed_ctx table every SQL file
# in this directory reads its scope from.
# ---------------------------------------------------------------------------

def _lit(value):
    """A single-quoted SQL literal.

    pg.py shells out to psql, so there are no bind parameters to reach for.
    Everything that arrives here is either a slug or a code already validated
    against a strict pattern, or a project name, which this escapes.
    """
    return "'" + str(value).replace("'", "''") + "'"


def upsert_row(project, status="generating"):
    """Create or update this project's row and return its id.

    Written before any geometry, so that a run interrupted half way leaves a
    row marked 'generating' rather than nothing at all -- the gallery renders
    that as a distinct state, and a project stuck in it is a visible symptom
    rather than a silent absence.
    """
    import pg  # local import: scripts/ is on sys.path by the time this is called

    layers = project.bhuvan_layers
    bhuvan = f"{_lit(json.dumps(layers))}::jsonb" if layers else "NULL"
    sql = f"""
    INSERT INTO projects (slug, name, bbox_geom, state_code, district_code,
                          scheme_code, status, bhuvan_layers)
    VALUES ({_lit(project.slug)}, {_lit(project.name)},
            ST_MakeEnvelope({project.west}, {project.south},
                            {project.east}, {project.north}, 4326),
            {_lit(project.state)}, {_lit(project.district)},
            {_lit(project.scheme)}, {_lit(status)}, {bhuvan})
    ON CONFLICT (slug) DO UPDATE SET
      name          = EXCLUDED.name,
      bbox_geom     = EXCLUDED.bbox_geom,
      state_code    = EXCLUDED.state_code,
      district_code = EXCLUDED.district_code,
      scheme_code   = EXCLUDED.scheme_code,
      status        = EXCLUDED.status,
      bhuvan_layers = EXCLUDED.bhuvan_layers;
    """
    pg.run(sql, quiet=True)
    return int(pg.scalar(
        f"SELECT id FROM projects WHERE slug = {_lit(project.slug)}"))


def set_status(project, status):
    import pg
    pg.run(
        f"UPDATE projects SET status = {_lit(status)} "
        f"WHERE slug = {_lit(project.slug)};",
        quiet=True,
    )


def write_elevation(project, elev_source, elev_datum):
    """Record where this project's ground_elev came from, and in which datum.

    'cartodem_v3' + 'msl_egm96' when scripts/dem.py sampled a real raster;
    'placeholder' + NULL when every building kept the 12.0 m default. The
    viewer and the README truth table read this rather than guessing from the
    values.
    """
    import pg
    datum = _lit(elev_datum) if elev_datum else "NULL"
    pg.run(
        f"UPDATE projects SET elev_source = {_lit(elev_source)}, "
        f"elev_datum = {datum} WHERE slug = {_lit(project.slug)};",
        quiet=True,
    )


def write_stats(project, stats):
    import pg
    pg.run(
        f"UPDATE projects SET stats = {_lit(json.dumps(stats))}::jsonb "
        f"WHERE slug = {_lit(project.slug)};",
        quiet=True,
    )


def make_seed_ctx(project, status="generating"):
    """Publish the project scope for build_geometry.sql and utilities.sql.

    A single-row UNLOGGED table rather than psql \\set variables: pg.py pipes
    SQL through `psql -f -`, and a variable set in one invocation does not
    survive into the next, so the two SQL files would each have to be told
    separately and could disagree. A table is set once and read by both.
    """
    import pg

    project_id = upsert_row(project, status)
    pg.run(
        f"""
        DROP TABLE IF EXISTS seed_ctx;
        CREATE UNLOGGED TABLE seed_ctx AS
        SELECT {project_id}::int          AS project_id,
               {_lit(project.slug)}::text     AS slug,
               {_lit(project.state)}::text    AS state_code,
               {_lit(project.district)}::text AS district_code,
               {_lit(project.scheme)}::text   AS scheme_code;
        """,
        quiet=True,
    )
    return project_id
