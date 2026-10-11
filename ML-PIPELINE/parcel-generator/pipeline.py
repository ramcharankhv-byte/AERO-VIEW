"""pipeline.py — one-call parcel layer generator (SIH PS 26011).

Tier 1 (BYOD): --byod register.geojson -> reproject + repair + IDs.
Tier 2 (dynamic): OSM roads -> blocks -> Voronoi split on footprint seeds.
No roads / fetch fail -> flagged grid fallback. Never empty output, never
silent: every fallback is stamped in properties.

Notebook (Kaggle Utility Script attached as parcel_generator):
    import sys; sys.path.insert(0, "/kaggle/input/parcel-generator")
    from pipeline import generate_parcel_layer
    out = generate_parcel_layer(
        bbox=[83.3130, 17.7180, 83.3245, 17.7280],
        footprints_geojson="/kaggle/working/Siripuram_Map_Tiles/tiles.json",
        output_dir="/kaggle/working/parcels")

CLI:
    python pipeline.py --bbox 83.313,17.718,83.3245,17.728 \\
        --footprints tiles.json --output_dir ./parcels
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:  # package import
    from .osm_fetch import fetch_roads, way_coords_lonlat
    from .blocks import build_blocks, to_metric
    from .parcels import grid_fallback_parcels, split_block, utm_epsg
    from .standardize import standardize
except ImportError:  # top-level import (folder itself on path)
    from osm_fetch import fetch_roads, way_coords_lonlat
    from blocks import build_blocks, to_metric
    from parcels import grid_fallback_parcels, split_block, utm_epsg
    from standardize import standardize

from shapely.geometry import LineString, mapping, shape
from pyproj import Transformer

DEFAULT_OUTPUT_DIR = "/kaggle/working/parcels"
METRIC_CRS = "EPSG:3857"
WGS84 = "EPSG:4326"

# Ramcharan's mocked Siripuram snapshot (flat file beside this module — Kaggle
# dataset uploads skip folders, so it lives here, not in data/).
# Auto-used when bbox == Siripuram and no --byod is given. Mocked demo data,
# NOT survey truth — always flagged synthetic + source aeroview-mock.
SIRIPURAM_BBOX = (83.313, 17.718, 83.3245, 17.728)
SIRIPURAM_SNAPSHOT = Path(__file__).resolve().parent / "siripuram_parcels.geojson"


def _is_siripuram(bbox_t) -> bool:
    return all(abs(a - b) < 1e-9 for a, b in zip(bbox_t, SIRIPURAM_BBOX))


def parse_bbox(s: str) -> tuple[float, float, float, float]:
    parts = [float(v.strip()) for v in s.split(",")]
    if len(parts) != 4:
        raise ValueError("--bbox needs 4 values: min_lon,min_lat,max_lon,max_lat")
    return (parts[0], parts[1], parts[2], parts[3])


def _metric_bbox(bbox, tf: Transformer) -> tuple[float, float, float, float]:
    xs, ys = [], []
    for lon, lat in [(bbox[0], bbox[1]), (bbox[0], bbox[3]),
                     (bbox[2], bbox[1]), (bbox[2], bbox[3])]:
        x, y = tf.transform(lon, lat)
        xs.append(x)
        ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys))


def _load_footprint_centroids(path: str | Path) -> tuple[list, str]:
    """Returns (centroids in native coords, crs). Refuses pixel coords loudly."""
    fc = json.loads(Path(path).read_text())
    feats = fc.get("features", [])
    if not feats:
        # tif pipeline's tiles.json is {crs, tiles:[...]}, not GeoJSON
        raise ValueError(
            f"{path} has no GeoJSON features — pass batch_infer output "
            "(*_footprints.geojson with --to-world), not tiles.json"
        )
    crs = "EPSG:3857" if isinstance(fc.get("crs"), dict) else WGS84
    pts = []
    for f in feats:
        try:
            g = shape(f["geometry"])
            if not g.is_empty and g.is_valid:
                pts.append(g.representative_point())
        except Exception:
            continue
    if not pts:
        return [], crs
    maxabs = max(max(abs(p.x), abs(p.y)) for p in pts)
    if crs == WGS84 and maxabs > 1000:
        # 3857 values without a crs member (batch_infer --to-world omits it)
        crs = METRIC_CRS
    if maxabs < 20000 and crs != WGS84:
        raise ValueError(
            "footprints look like village-PIXEL coords (max %.0f) — re-run "
            "batch_infer.py with --to-world for EPSG:3857" % maxabs
        )
    return pts, crs


def _export(parcels: list[dict], out: Path) -> Path:
    feats = [{
        "type": "Feature",
        "properties": {k: v for k, v in p.items() if k != "geometry"},
        "geometry": mapping(p["geometry"]),
    } for p in parcels]
    fc = {"type": "FeatureCollection",
          "crs": {"type": "name", "properties": {"name": "EPSG:3857"}},
          "features": feats}
    dest = out / "parcels.geojson"
    dest.write_text(json.dumps(fc))
    return dest


def generate_parcel_layer(
    bbox: list[float] | tuple[float, float, float, float],
    footprints_geojson: str | None = None,
    byod_file: str | None = None,
    output_dir: str = DEFAULT_OUTPUT_DIR,
    setback_m: float = 2.5,
    min_block_m2: float = 200.0,
    grid_cell_m: float = 50.0,
    id_prop: str = "parcel_id",
) -> dict:
    """Build parcels.geojson for bbox. See module docstring. Returns manifest."""
    bbox_t = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    if not (bbox_t[0] < bbox_t[2] and bbox_t[1] < bbox_t[3]):
        raise ValueError(f"bad bbox: {bbox_t}")
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    clon, clat = (bbox_t[0] + bbox_t[2]) / 2, (bbox_t[1] + bbox_t[3]) / 2
    utm = utm_epsg(clon, clat)
    to_m = Transformer.from_crs(WGS84, METRIC_CRS, always_xy=True)
    mbbox = _metric_bbox(bbox_t, to_m)
    return _run(bbox_t, mbbox, utm, out, footprints_geojson, byod_file,
                setback_m, min_block_m2, grid_cell_m, id_prop)


def _run(bbox_t, mbbox, utm, out, footprints_geojson, byod_file,
         setback_m, min_block_m2, grid_cell_m, id_prop) -> dict:
    # import here: keeps facade importable even if sibling import style varies
    try:
        from .parcels import area_m2_utm
    except ImportError:
        from parcels import area_m2_utm

    if byod_file:
        parcels = standardize(byod_file, dst_crs=METRIC_CRS, id_prop=id_prop)
        for p in parcels:
            p["area_m2"] = round(area_m2_utm(p["geometry"], METRIC_CRS, utm), 1)
        dest = _export(parcels, out)
        return _manifest(out, dest, parcels, "byod", list(bbox_t))

    if _is_siripuram(bbox_t) and SIRIPURAM_SNAPSHOT.exists():
        parcels = standardize(SIRIPURAM_SNAPSHOT, dst_crs=METRIC_CRS,
                              id_prop="ulpin", synthetic=True)
        for p in parcels:
            p["area_m2"] = round(area_m2_utm(p["geometry"], METRIC_CRS, utm), 1)
            p["status"] = "aeroview-mock"
            p["source"] = "aeroview-mock"
        dest = _export(parcels, out)
        return _manifest(out, dest, parcels, "siripuram-snapshot", list(bbox_t))

    # Tier 2: roads -> blocks
    try:
        raw = fetch_roads(bbox_t, out / "_osm_cache")
        lines_ll = way_coords_lonlat(raw)
    except RuntimeError as e:
        print(f"[warn] {e} — grid fallback")
        lines_ll = []
    lines_m, _ = to_metric([LineString(l) for l in lines_ll]) if lines_ll else ([], None)
    blocks = build_blocks(lines_m, mbbox, min_area_m2=min_block_m2) if lines_m else []

    seeds: list = []
    if footprints_geojson:
        pts, crs = _load_footprint_centroids(footprints_geojson)
        if crs == WGS84:
            tf = Transformer.from_crs(WGS84, METRIC_CRS, always_xy=True)
            seeds = [shape(mapping(p)) for p in pts]
            from shapely.ops import transform as _t
            seeds = [_t(lambda x, y: tf.transform(x, y), p) for p in seeds]
        else:
            seeds = pts

    parcels: list[dict] = []
    if not blocks:
        parcels = grid_fallback_parcels(mbbox, 1, cell_m=grid_cell_m,
                                        metric_crs=METRIC_CRS, utm=utm)
        mode = "grid-fallback-no-roads"
    else:
        for i, blk in enumerate(blocks, 1):
            blk_seeds = [s for s in seeds if blk.contains(s)]
            parcels.extend(split_block(blk, blk_seeds, i, setback_m=setback_m,
                                       metric_crs=METRIC_CRS, utm=utm))
        mode = "osm-voronoi" if seeds else "osm-blocks-no-seeds"
    dest = _export(parcels, out)
    return _manifest(out, dest, parcels, mode, list(bbox_t))


def _manifest(out: Path, dest: Path, parcels: list[dict], mode: str, bbox: list) -> dict:
    from collections import Counter
    stats = dict(Counter(p["status"] for p in parcels))
    m = {"output_dir": str(out), "parcels": str(dest), "n": len(parcels),
         "mode": mode, "bbox": bbox, "crs": METRIC_CRS, "status": stats,
         "synthetic": all(p.get("synthetic", False) for p in parcels)}
    (out / "manifest.json").write_text(json.dumps(m, indent=1))
    print(f"[done] {len(parcels)} parcels ({mode}) {stats} -> {dest.name}")
    return m


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate parcel layer for a bbox")
    ap.add_argument("--bbox", required=True, help="min_lon,min_lat,max_lon,max_lat")
    ap.add_argument("--footprints", default=None, help="batch_infer --to-world GeoJSON")
    ap.add_argument("--byod", default=None, help="Tier 1 register GeoJSON")
    ap.add_argument("--output_dir", default=DEFAULT_OUTPUT_DIR)
    ap.add_argument("--setback", type=float, default=2.5)
    ap.add_argument("--min-block", type=float, default=200.0)
    ap.add_argument("--cell", type=float, default=50.0)
    ap.add_argument("--id-prop", default="parcel_id")
    args = ap.parse_args(argv)
    generate_parcel_layer(
        bbox=parse_bbox(args.bbox), footprints_geojson=args.footprints,
        byod_file=args.byod, output_dir=args.output_dir, setback_m=args.setback,
        min_block_m2=args.min_block, grid_cell_m=args.cell, id_prop=args.id_prop,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
