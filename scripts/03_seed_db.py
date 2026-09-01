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

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

STAGE_DDL = """
CREATE UNLOGGED TABLE IF NOT EXISTS stage_building (doc jsonb);
CREATE UNLOGGED TABLE IF NOT EXISTS stage_highway  (doc jsonb);
TRUNCATE parcel, building, floor, unit, conflict RESTART IDENTITY CASCADE;
"""


def main():
    path = os.path.join(DATA, "buildings_attributed.geojson")
    if not os.path.exists(path):
        raise SystemExit("run scripts/02_heights.py first")
    with open(path, encoding="utf-8") as fh:
        buildings = json.load(fh)["features"]

    hw_path = os.path.join(DATA, "raw_highways.geojson")
    highways = []
    if os.path.exists(hw_path):
        with open(hw_path, encoding="utf-8") as fh:
            highways = json.load(fh)["features"]

    print(f"staging {len(buildings)} buildings, {len(highways)} road ways")
    pg.run(STAGE_DDL, quiet=True)
    pg.copy_json("stage_building", "doc", buildings)
    pg.copy_json("stage_highway", "doc", highways)

    print("building cadastral geometry (this does the metric work in UTM 44N)...")
    pg.run_file(os.path.join(HERE, "build_geometry.sql"))

    # sanity gate: the pipeline must not silently produce an empty cadastre
    counts = {
        name: int(pg.scalar(f"SELECT count(*) FROM {name}"))
        for name in ("parcel", "building", "floor", "unit")
    }
    print("\nseeded:", ", ".join(f"{k}={v}" for k, v in counts.items()))
    for name, n in counts.items():
        if n == 0:
            raise SystemExit(f"FAILED: {name} table is empty")

    sources = pg.rows(
        "SELECT height_source, count(*) FROM building GROUP BY 1 ORDER BY 2 DESC")
    print("provenance:", ", ".join(f"{s}={n}" for s, n in sources))


if __name__ == "__main__":
    main()
