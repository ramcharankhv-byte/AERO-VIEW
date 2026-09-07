"""Load an OFFICIAL survey-parcel file into survey_parcel, replacing the
derived layer for one project.

    python scripts/import_survey_parcels.py \\
        --path=data/incoming/siripuram_ts_parcels.geojson \\
        --slug=siripuram \\
        --source="Andhra Pradesh Survey Settlements and Land Records" \\
        --source-date=2026-03-14

This is the whole point of the survey_parcel table. Everything the pipeline
generates carries provenance='derived' and is labelled, in words, as an
unofficial parcel derived from OpenStreetMap. When a real register arrives,
this loads it with provenance='survey_dept', re-runs the building join, and
re-exports the snapshot -- and the badge in the interface flips from "Derived
parcel (unofficial)" to "Survey parcel · <source>" because the panel reads the
column rather than being told. Nothing else in the application changes.

WHAT IT WILL NOT DO. It will not invent a survey number, a TS number, an LPM
number or a 14-digit Bhu-Aadhaar for a feature that does not carry one. Those
columns stay NULL and the interface goes on saying it does not have them.
`--source` is REQUIRED and the CHECK constraint on the table enforces it: a row
claiming to be from the survey department has to say which one.

INPUT FORMATS. GeoJSON is read with the standard library. A shapefile is
converted first with `ogr2ogr`, which the seed-only geospatial toolchain in
.gdal-env provides (see README, "Seeding and the geospatial toolchain"); run
this through `.gdal-env/python.exe` for that path, or convert the shapefile
yourself and pass the GeoJSON. No new runtime dependency either way.

FIELD MAPPING. Property names differ between departments, so each column is
looked up under several spellings and can be overridden:

    --label-field=  --ts-field=  --lpm-field=  --ulpin-field=  --class-field=

`label` is the only one that must resolve, because it is what the map draws and
what the parcel identifier is built from. Where the file carries no such field,
features are numbered 0001.. in file order and the run says so -- an ordinal is
a position in a list, not a claim about a survey.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg  # noqa: E402
import project as proj  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# Candidate property names per column, tried in order. Lower-cased on both
# sides before matching, so TS_NO and ts_no are the same field.
FIELDS = {
    "label": ["label", "parcel_no", "plot_no", "survey_no", "sy_no", "surveyno",
              "lp_no", "parcelno"],
    "ts_no": ["ts_no", "tsno", "town_survey_no", "ts_number"],
    "lpm_no": ["lpm_no", "lpmno", "lpm", "lp_no"],
    "ulpin_14": ["ulpin_14", "ulpin", "bhu_aadhaar", "bhuaadhaar", "ulpin14"],
    "classification": ["classification", "class", "land_class", "landuse",
                       "class_desc"],
}


def opts_from(argv):
    out = {}
    for arg in argv:
        if arg.startswith("--") and "=" in arg:
            key, _, value = arg[2:].partition("=")
            out[key.strip()] = value
    return out


def to_geojson(path):
    """Return a GeoJSON dict for a .geojson/.json or .shp path."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".geojson", ".json"):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    if ext != ".shp":
        raise SystemExit(
            f"import: unsupported extension {ext!r}. Pass a .geojson, .json "
            f"or .shp.")

    ogr = shutil.which("ogr2ogr") or _gdal_env_tool("ogr2ogr")
    if not ogr:
        raise SystemExit(
            "import: a shapefile needs ogr2ogr, which is not on PATH and not "
            "in .gdal-env.\n"
            "  Either run this through the seed toolchain:\n"
            "    .gdal-env/python.exe scripts/import_survey_parcels.py ...\n"
            "  or convert it yourself and pass the GeoJSON:\n"
            "    ogr2ogr -f GeoJSON -t_srs EPSG:4326 parcels.geojson parcels.shp")

    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "parcels.geojson")
        # -t_srs is not optional: a survey shapefile is routinely in a state
        # grid or a UTM zone, and loading its northings as latitudes would put
        # the whole cadastre off the coast of Africa without erroring.
        cmd = [ogr, "-f", "GeoJSON", "-t_srs", "EPSG:4326", out, path]
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise SystemExit(f"import: ogr2ogr failed:\n{r.stderr.strip()}")
        with open(out, encoding="utf-8") as fh:
            return json.load(fh)


def _gdal_env_tool(name):
    root = os.path.normpath(os.path.join(HERE, "..", ".gdal-env"))
    for rel in (name + ".exe", os.path.join("Library", "bin", name + ".exe"),
                os.path.join("bin", name)):
        cand = os.path.join(root, rel)
        if os.path.exists(cand):
            return cand
    return None


def pick(props, column, override):
    """The value of one column for one feature, or None."""
    if override:
        return props.get(override)
    lowered = {str(k).lower(): v for k, v in props.items()}
    for name in FIELDS[column]:
        if lowered.get(name) not in (None, ""):
            return lowered[name]
    return None


def rings(geom):
    """Polygon rings from a Polygon or MultiPolygon, largest part first.

    A survey sheet routinely holds a parcel as a MultiPolygon -- a plot split
    by a road reserve, say. survey_parcel.geom is a Polygon, matching parcel,
    so the largest part is kept and the run reports how many features lost one.
    Approximating area by ring vertex extent is enough to order them; the
    authoritative extent is recomputed in PostGIS below.
    """
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return sorted(geom["coordinates"], key=_ring_span, reverse=True)
    return []


def _ring_span(poly):
    xs = [p[0] for p in poly[0]]
    ys = [p[1] for p in poly[0]]
    return (max(xs) - min(xs)) * (max(ys) - min(ys))


def resolve(opts):
    """The project to import into, by slug, from the database.

    NOT proj.parse_args(): that one is built for CREATING a project and demands
    --name and --bbox alongside --slug, because a seed with a missing bbox is a
    seed of the wrong place. An import is the opposite case -- the project must
    already exist, so asking the caller to restate its bounding box is asking
    them to get it wrong. The row is the authority; this reads it.
    """
    slug = (opts.get("slug") or proj.DEFAULT_SLUG).strip().lower()
    row = pg.rows(
        "SELECT name, state_code, district_code, scheme_code, "
        "ST_XMin(bbox_geom), ST_YMin(bbox_geom), "
        "ST_XMax(bbox_geom), ST_YMax(bbox_geom) "
        f"FROM projects WHERE slug = {proj._lit(slug)}")
    if not row:
        raise SystemExit(
            f"import: no project {slug!r} in the database. Seed it first:\n"
            f"  npm run seed -- --slug={slug} --name=... --bbox=...")
    name, state, district, scheme, w, s_, e, n = row[0]
    return proj.Project(slug=slug, name=name, bbox=(w, s_, e, n),
                        state=state, district=district, scheme=scheme)


def main():
    argv = sys.argv[1:]
    opts = opts_from(argv)

    path = opts.get("path")
    source = opts.get("source")
    if not path:
        raise SystemExit("import: --path=<geojson|shp> is required")
    if not source or not source.strip():
        raise SystemExit(
            "import: --source=\"<issuing authority>\" is required. A row marked "
            "provenance='survey_dept' has to say which department issued it -- "
            "the database CHECK constraint enforces it, and the panel prints "
            "it. An import with no attributable source is a derived layer with "
            "a better badge, which is the one thing this table exists to "
            "prevent.")
    if not os.path.exists(path):
        raise SystemExit(f"import: no such file: {path}")
    source_date = opts.get("source-date") or None

    p = resolve(opts)

    doc = to_geojson(path)
    feats = doc.get("features") or []
    if not feats:
        raise SystemExit(f"import: {path} holds no features")

    project_id = proj.make_seed_ctx(p, status="generating")

    rows, dropped_parts, no_label, seen = [], 0, 0, set()
    for i, feat in enumerate(feats):
        parts = rings(feat.get("geometry"))
        if not parts:
            continue
        if len(parts) > 1:
            dropped_parts += 1
        props = feat.get("properties") or {}

        label = pick(props, "label", opts.get("label-field"))
        if label in (None, ""):
            label = f"{i + 1:04d}"
            no_label += 1
        label = str(label).strip()
        if label in seen:
            # UNIQUE (project_id, label) would abort the whole transaction
            # several thousand rows later with a message naming neither file
            # nor feature. Say which one, here.
            raise SystemExit(
                f"import: label {label!r} appears more than once (feature "
                f"{i + 1}). Pass --label-field= to choose the column that is "
                f"actually unique in this file.")
        seen.add(label)

        rows.append({
            "label": label,
            "ts_no": pick(props, "ts_no", opts.get("ts-field")),
            "lpm_no": pick(props, "lpm_no", opts.get("lpm-field")),
            "ulpin_14": pick(props, "ulpin_14", opts.get("ulpin-field")),
            "classification": pick(props, "classification",
                                   opts.get("class-field")),
            "geometry": {"type": "Polygon", "coordinates": parts[0]},
        })

    print(f"import: {len(rows)} parcel(s) from {os.path.basename(path)}")
    if no_label:
        print(f"  {no_label} feature(s) carried no parcel number and were "
              f"numbered by position. An ordinal is a place in a list, not a "
              f"survey number, and the panel labels them accordingly.")
    if dropped_parts:
        print(f"  {dropped_parts} multipolygon(s): largest part kept "
              f"(survey_parcel.geom is a Polygon, as parcel.geom is)")

    # Stage, then insert in SQL, so the geometry is validated and the extent is
    # computed by PostGIS in UTM rather than approximated here.
    pg.run("CREATE UNLOGGED TABLE IF NOT EXISTS stage_survey (doc jsonb);",
           quiet=True)
    pg.copy_json("stage_survey", "doc", rows)

    # proj._lit is the single-quoting every seed script here uses; there is no
    # public alias for it and adding one for a fourth caller in the same
    # package would be ceremony.
    lit = proj._lit  # noqa: SLF001
    date_sql = lit(source_date) + "::date" if source_date else "NULL"
    pg.run(f"""
\\set ON_ERROR_STOP on
BEGIN;

DELETE FROM survey_parcel WHERE project_id = {project_id};

ALTER TABLE seed_ctx ADD COLUMN IF NOT EXISTS survey_parcel_off int;
UPDATE seed_ctx
   SET survey_parcel_off = COALESCE((SELECT max(id) FROM survey_parcel), 0);

INSERT INTO survey_parcel (id, project_id, label, ts_no, lpm_no, ulpin_14,
                           extent_sqm, classification, provenance, source,
                           source_date, geom)
SELECT (row_number() OVER (ORDER BY s.doc ->> 'label')
          + (SELECT survey_parcel_off FROM seed_ctx))::int,
       {project_id},
       s.doc ->> 'label',
       s.doc ->> 'ts_no',
       s.doc ->> 'lpm_no',
       s.doc ->> 'ulpin_14',
       round(ST_Area(ST_Transform(g.geom, 32644))::numeric, 2)::double precision,
       s.doc ->> 'classification',
       'survey_dept',
       {lit(source.strip())},
       {date_sql},
       g.geom
  FROM stage_survey s,
       LATERAL (SELECT ST_MakeValid(ST_Force2D(ST_SetSRID(
                  ST_GeomFromGeoJSON(s.doc ->> 'geometry'), 4326))) AS geom) g
 WHERE ST_GeometryType(g.geom) = 'ST_Polygon' AND NOT ST_IsEmpty(g.geom);

COMMIT;
""", quiet=True)

    loaded = int(pg.scalar(
        f"SELECT count(*) FROM survey_parcel WHERE project_id = {project_id}"))
    if loaded < len(rows):
        print(f"  {len(rows) - loaded} feature(s) rejected by PostGIS as "
              f"non-polygonal or empty after ST_MakeValid")

    # The SAME join the derived build runs. Not a copy of it -- see the header
    # of scripts/survey_parcel_join.sql.
    pg.run_file(os.path.join(HERE, "survey_parcel_join.sql"))

    print("\nre-exporting snapshots")
    r = subprocess.run(
        [sys.executable, os.path.join(HERE, "05_export_static.py"),
         f"--slug={p.slug}", f"--name={p.name}",
         f"--bbox={','.join(str(v) for v in p.bbox)}",
         f"--state={p.state}", f"--district={p.district}"],
        cwd=os.path.normpath(os.path.join(HERE, "..")))
    if r.returncode != 0:
        raise SystemExit(
            f"import: parcels loaded, but the export failed (exit "
            f"{r.returncode}). The database is correct; data/api/{p.slug}/ is "
            f"stale. Re-run scripts/05_export_static.py.")

    print(f"\n{loaded} survey parcel(s) loaded for {p.slug}, "
          f"provenance='survey_dept', source={source.strip()!r}")


if __name__ == "__main__":
    main()
