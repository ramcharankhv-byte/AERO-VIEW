"""Build the survey_parcel layer for one project.

    python scripts/survey_parcels.py --slug=hyderabad-banjara ...

Runs between `streets` and `export snapshots` in scripts/seed.py, because
scripts/05_export_static.py writes data/api/<slug>/survey_parcels.json and
cannot export a table that has not been built.

WHAT IT DOES. Stages this project's road centrelines and landuse areas into
jsonb tables, then hands the geometry to scripts/survey_parcels.sql, which does
the metric work in EPSG:32644: Voronoi cells over the existing parcel seeds,
clipped to the road corridors and to landuse where there is any, and slivers
dissolved. Then scripts/survey_parcel_join.sql sets building.survey_parcel_id
by largest shared area -- its own file because the importer runs it again.

IT STAGES ITS OWN INPUTS rather than relying on what 03_seed_db.py left behind.
The stage_* tables are per-RUN scratch, not per-project state -- they hold
whichever project was seeded last. Reading them without refilling them would
make a standalone re-run of this stage quietly clip Siripuram's parcels to
Hyderabad's streets, and the result would look entirely plausible.

NOTHING HERE IS A SURVEY. Every row written carries provenance='derived'.
scripts/import_survey_parcels.py is the path a real register takes; see the
header of scripts/survey_parcels.sql.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg  # noqa: E402
import project as proj  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

STAGE_DDL = """
CREATE UNLOGGED TABLE IF NOT EXISTS stage_highway (doc jsonb);
CREATE UNLOGGED TABLE IF NOT EXISTS stage_landuse (doc jsonb);
"""


def features(path):
    """The features of a GeoJSON file, or [] when it is not there.

    raw_landuse.geojson is legitimately absent: scripts/01_fetch_osm.py treats
    the landuse Overpass query as non-fatal. An empty table is a supported
    input, not a failure -- survey_parcels.sql branches on the row count.
    """
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh).get("features", [])


def main():
    p = proj.parse_args()
    print(f"survey parcels for {p.slug}")

    highways = features(p.raw_highways_path)
    landuse = features(p.raw_landuse_path)
    if not highways:
        raise SystemExit(
            f"survey_parcels: no road centrelines for {p.slug} "
            f"({p.raw_highways_path}). Run scripts/01_fetch_osm.py first -- "
            f"parcels are defined by the streets they are bounded by, and "
            f"building them without any would produce one cell per plot with "
            f"nothing cut out of it, which is what `parcel` already is.")
    if not landuse:
        print("  no landuse extract for this project; parcels will be clipped "
              "to road corridors only (see scripts/01_fetch_osm.py)")

    # Publishes the project row and the seed_ctx table survey_parcels.sql reads
    # its scope from. Must happen before the SQL file runs.
    proj.make_seed_ctx(p)

    print(f"  staging {len(highways)} road ways, {len(landuse)} landuse areas")
    pg.run(STAGE_DDL, quiet=True)
    pg.copy_json("stage_highway", "doc", highways)
    pg.copy_json("stage_landuse", "doc", landuse)

    pg.run_file(os.path.join(HERE, "survey_parcels.sql"))
    # A separate file and a separate transaction, because it runs again after
    # scripts/import_survey_parcels.py replaces the layer with a real one.
    pg.run_file(os.path.join(HERE, "survey_parcel_join.sql"))

    scope = "(SELECT project_id FROM seed_ctx)"
    n = int(pg.scalar(
        f"SELECT count(*) FROM survey_parcel WHERE project_id = {scope}"))
    if n == 0:
        raise SystemExit(
            "FAILED: survey_parcel is empty for this project. Every cell was "
            "cut away, which means the road corridors covered the whole area "
            "of interest -- check the widths in scripts/survey_parcels.sql "
            "against lib/roads/corridors.ts.")

    unplaced = int(pg.scalar(
        f"SELECT count(*) FROM building WHERE project_id = {scope}"
        f" AND survey_parcel_id IS NULL"))
    print(f"\n{n} survey parcels, {unplaced} building(s) unplaced")


if __name__ == "__main__":
    main()
