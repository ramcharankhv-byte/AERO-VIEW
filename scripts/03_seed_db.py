"""03 - Seed PostGIS with the cadastral stack: parcel -> building -> floor -> unit.

Stages the attributed GeoJSON into jsonb tables, then hands the geometry work to
scripts/build_geometry.sql, which does everything metric in EPSG:32644 and
stores the results back in 4326 with Z in metres.

Input:  data/buildings_attributed.geojson
Output: rows in parcel/building/floor/unit
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg  # noqa: E402
import project as proj  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# The staging tables are per-run scratch, not per-project state: they are
# truncated and refilled by copy_json below on every invocation. What used to
# sit here -- a TRUNCATE of the whole cadastre -- has moved into
# build_geometry.sql, which deletes ONE project's rows instead. Truncating
# every table here would have wiped a sibling AOI the moment a second one
# existed.
STAGE_DDL = """
CREATE UNLOGGED TABLE IF NOT EXISTS stage_building (doc jsonb);
CREATE UNLOGGED TABLE IF NOT EXISTS stage_highway  (doc jsonb);
"""


def main():
    p = proj.parse_args()
    print(f"seeding {p.describe()}")

    path = p.attributed_path
    if not os.path.exists(path):
        raise SystemExit(f"run scripts/02_heights.py first (no {path})")
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    buildings = doc["features"]
    # Written by 02_heights.py: where ground_elev came from, and its datum.
    elevation = doc.get("elevation") or {}

    hw_path = p.raw_highways_path
    highways = []
    if os.path.exists(hw_path):
        with open(hw_path, encoding="utf-8") as fh:
            highways = json.load(fh)["features"]

    # Publishes the project row and the seed_ctx table that build_geometry.sql
    # reads its scope from. Must happen before the SQL file runs.
    proj.make_seed_ctx(p)
    proj.write_elevation(p, elevation.get("elev_source", "placeholder"),
                         elevation.get("elev_datum"))

    print(f"staging {len(buildings)} buildings, {len(highways)} road ways")
    pg.run(STAGE_DDL, quiet=True)
    pg.copy_json("stage_building", "doc", buildings)
    pg.copy_json("stage_highway", "doc", highways)

    print("building cadastral geometry (this does the metric work in UTM 44N)...")
    pg.run_file(os.path.join(HERE, "build_geometry.sql"))

    # sanity gate: the pipeline must not silently produce an empty cadastre.
    # Counted for THIS project only -- a sibling AOI's rows would otherwise
    # mask an empty seed and turn this gate into a no-op.
    scoped = {
        "parcel":   "SELECT count(*) FROM parcel WHERE project_id = (SELECT project_id FROM seed_ctx)",
        "building": "SELECT count(*) FROM building WHERE project_id = (SELECT project_id FROM seed_ctx)",
        "floor":    "SELECT count(*) FROM floor f JOIN building b ON b.id = f.building_id"
                    " WHERE b.project_id = (SELECT project_id FROM seed_ctx)",
        "unit":     "SELECT count(*) FROM unit u JOIN floor f ON f.id = u.floor_id"
                    " JOIN building b ON b.id = f.building_id"
                    " WHERE b.project_id = (SELECT project_id FROM seed_ctx)",
    }
    counts = {name: int(pg.scalar(sql)) for name, sql in scoped.items()}
    print("\nseeded:", ", ".join(f"{k}={v}" for k, v in counts.items()))
    for name, n in counts.items():
        if n == 0:
            raise SystemExit(f"FAILED: {name} table is empty")

    sources = pg.rows(
        "SELECT height_source, count(*) FROM building"
        " WHERE project_id = (SELECT project_id FROM seed_ctx)"
        " GROUP BY 1 ORDER BY 2 DESC")
    print("provenance:", ", ".join(f"{s}={n}" for s, n in sources))


if __name__ == "__main__":
    main()
