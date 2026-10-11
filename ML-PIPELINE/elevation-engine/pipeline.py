"""pipeline.py — master orchestrator for Input 3 elevation (SIH PS 26011).

Decoupled Z-axis: Copernicus GLO-30 ground anchor (Z_base) + Overture
multi-source height consensus (H_final) -> volumetric bounds + floor slices.

Notebook (Kaggle Utility Script attached as elevation_engine):
    import sys; sys.path.insert(0, "/kaggle/input/elevation-engine")
    from pipeline import generate_elevation_layer
    gdf = generate_elevation_layer([83.3130, 17.7180, 83.3245, 17.7280])

CLI:
    python pipeline.py --bbox 83.313,17.718,83.3245,17.728 --output_dir ./elevation
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:  # package import
    from .ground import (
        close_copernicus_tile,
        open_copernicus_tile,
        robust_ground_sample,
        tile_key_for_lonlat,
        utm_epsg_for_lonlat,
    )
    from .overture import get_overture_buildings
    from .consensus import fuse_heights, typology_prior
except ImportError:  # top-level import (folder itself on path)
    from ground import (
        close_copernicus_tile,
        open_copernicus_tile,
        robust_ground_sample,
        tile_key_for_lonlat,
        utm_epsg_for_lonlat,
    )
    from overture import get_overture_buildings
    from consensus import fuse_heights, typology_prior

DEFAULT_OUTPUT_DIR = "/kaggle/working/elevation"
FLOOR_HEIGHT_M = 3.0
BASEMENT_DEPTH_M = 3.0
VERTICAL_DATUM = "EGM2008"


def parse_bbox(s: str) -> tuple[float, float, float, float]:
    parts = [float(v.strip()) for v in s.split(",")]
    if len(parts) != 4:
        raise ValueError("--bbox needs 4 values: min_lon,min_lat,max_lon,max_lat")
    return (parts[0], parts[1], parts[2], parts[3])


def _to_float_or_none(v) -> float | None:
    try:
        if v is None:
            return None
        f = float(v)
    except Exception:
        return None
    import math

    return f if math.isfinite(f) and f > 0 else None


_OUTPUT_COLUMNS = [
    "building_id", "Z_base", "Z_ground", "H_final", "height",
    "height_sigma", "confidence", "floors", "Z_roof", "Z_sub",
    "floor_slices", "sources", "area_m2", "vertical_datum", "utm_crs",
]


def _empty_output_gdf():
    """Empty result-layer GDF with the final display schema (EPSG:4326).

    Guarantees gdf[["building_id", "Z_base", ...]] never KeyErrors,
    even when Overture returns 0 rows for the bbox.
    """
    import geopandas as _gpd

    return _gpd.GeoDataFrame(
        {c: [] for c in _OUTPUT_COLUMNS},
        geometry=[],
        crs="EPSG:4326",
    )


def generate_elevation_layer(
    bbox: list[float] | tuple[float, float, float, float],
    footprints_gdf=None,
    output_dir: str = DEFAULT_OUTPUT_DIR,
):
    """Build the elevated-buildings layer for bbox.

    Args:
        bbox: [min_lon, min_lat, max_lon, max_lat] (EPSG:4326).
        footprints_gdf: Optional GeoDataFrame of footprints (any CRS; will be
            reprojected). When None, Overture buildings are streamed for bbox.
        output_dir: Directory receiving elevated_buildings.geojson + manifest.

    Returns:
        GeoDataFrame (EPSG:4326) with per-building Z_ground, Z_roof, Z_sub,
        H_final/height, height_sigma, confidence, floors, floor_slices,
        sources, area_m2 and LADM quality attributes.
    """
    import geopandas as gpd

    bbox_t = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    if not (bbox_t[0] < bbox_t[2] and bbox_t[1] < bbox_t[3]):
        raise ValueError(f"bad bbox: {bbox_t}")
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    if footprints_gdf is None:
        gdf = get_overture_buildings(list(bbox_t))
    else:
        gdf = footprints_gdf.copy()
        if gdf.crs is None:
            gdf = gdf.set_crs("EPSG:4326")

    if gdf is None or len(gdf) == 0:
        empty_gdf = _empty_output_gdf()
        (out / "elevated_buildings.geojson").write_text(
            empty_gdf.to_json() if len(empty_gdf) else '{"type":"FeatureCollection","features":[]}'
        )
        (out / "manifest.json").write_text(json.dumps({"n": 0, "bbox": list(bbox_t), "crs": "EPSG:4326"}, indent=1))
        print("[done] 0 buildings — empty elevation layer")
        return empty_gdf

    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    else:
        gdf = gdf.to_crs("EPSG:4326")

    clon, clat = (bbox_t[0] + bbox_t[2]) / 2.0, (bbox_t[1] + bbox_t[3]) / 2.0
    utm = utm_epsg_for_lonlat(clon, clat)
    g_utm = gdf.to_crs(utm)

    # Copernicus tile cache: bbox may span 1° boundaries — open per building.
    tiles: dict[str, tuple] = {}

    def _src_for(lon: float, lat: float):
        key = tile_key_for_lonlat(lon, lat)
        if key not in tiles:
            tiles[key] = open_copernicus_tile(lon, lat)
        return tiles[key][0]

    try:
        _src_for(clon, clat)
    except Exception as e:
        print(f"[warn] copernicus open failed ({e}) — Z_base falls back to 0")

    records: list[dict] = []
    try:
        for idx in range(len(gdf)):
            row = gdf.iloc[idx]
            geom_utm = g_utm.geometry.iloc[idx]
            if geom_utm is None or geom_utm.is_empty:
                continue
            area_m2 = float(geom_utm.area)
            lon, lat = float(row.geometry.centroid.x), float(row.geometry.centroid.y)

            # --- Z_base: Copernicus annulus median ---
            try:
                src = _src_for(lon, lat)
                z_base = float(robust_ground_sample(src, geom_utm, utm))
            except Exception:
                z_base = 0.0

            # --- H candidates ---
            h_direct = _to_float_or_none(row.get("height") if hasattr(row, "get") else row["height"] if "height" in gdf.columns else None)
            n_floors_raw = _to_float_or_none(row.get("num_floors") if hasattr(row, "get") else row["num_floors"] if "num_floors" in gdf.columns else None)
            prior = typology_prior(area_m2=area_m2, urban=True)
            candidates = [prior]
            if h_direct is not None and 2.0 <= h_direct <= 120.0:
                candidates.append({"source": "overture-height", "value": h_direct, "sigma": 2.0})
            if n_floors_raw is not None and 1 <= n_floors_raw <= 40:
                candidates.append({"source": "overture-floors", "value": float(n_floors_raw) * FLOOR_HEIGHT_M, "sigma": 3.0})

            fused = fuse_heights(candidates)
            h_final = float(fused["height"])
            floors = int(fused["floors"])

            z_ground = float(z_base)
            z_roof = float(z_base + h_final)
            z_sub = float(z_base - BASEMENT_DEPTH_M)
            floor_slices = [
                [round(z_ground + i * FLOOR_HEIGHT_M, 3), round(z_ground + (i + 1) * FLOOR_HEIGHT_M, 3)]
                for i in range(max(floors, 1))
            ]
            bid = str(row.get("id", f"B-{idx + 1:05d}")) if hasattr(row, "get") else f"B-{idx + 1:05d}"
            records.append(
                {
                    "building_id": bid,
                    "geometry": row.geometry,
                    "Z_base": round(z_ground, 3),
                    "Z_ground": round(z_ground, 3),
                    "H_final": round(h_final, 2),
                    "height": round(h_final, 2),
                    "height_sigma": float(fused["sigma"]),
                    "confidence": float(fused["confidence"]),
                    "floors": floors,
                    "Z_roof": round(z_roof, 3),
                    "Z_sub": round(z_sub, 3),
                    "floor_slices": floor_slices,
                    "sources": ",".join(fused["sources"]),
                    "area_m2": round(area_m2, 1),
                    "vertical_datum": VERTICAL_DATUM,
                    "utm_crs": utm,
                }
            )
    finally:
        for src, env in tiles.values():
            try:
                close_copernicus_tile(src, env)
            except Exception:
                pass

    import geopandas as gpd

    if not records:
        out_gdf = _empty_output_gdf()
    else:
        out_gdf = gpd.GeoDataFrame(records, geometry="geometry", crs="EPSG:4326")
    dest = out / "elevated_buildings.geojson"
    # to_json + plain write: no GDAL/pyogrio involved (Windows MAX_PATH-safe,
    # Kaggle-safe). to_file(engine="pyogrio") breaks on some Windows boxes.
    dest.write_text(out_gdf.to_json())
    manifest = {
        "output_dir": str(out),
        "buildings": str(dest),
        "n": len(out_gdf),
        "bbox": list(bbox_t),
        "crs": "EPSG:4326",
        "utm_crs": utm,
        "vertical_datum": VERTICAL_DATUM,
        "floor_height_m": FLOOR_HEIGHT_M,
        "basement_m": BASEMENT_DEPTH_M,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"[done] {len(out_gdf)} elevated buildings -> {dest.name}")
    return out_gdf


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate elevation layer for a bbox")
    ap.add_argument("--bbox", required=True, help="min_lon,min_lat,max_lon,max_lat")
    ap.add_argument("--footprints", default=None, help="optional footprints GeoJSON (skips Overture fetch)")
    ap.add_argument("--output_dir", default=DEFAULT_OUTPUT_DIR)
    args = ap.parse_args(argv)
    fp = None
    if args.footprints:
        import geopandas as gpd

        fp = gpd.read_file(args.footprints)
    generate_elevation_layer(parse_bbox(args.bbox), footprints_gdf=fp, output_dir=args.output_dir)
    return 0


if __name__ == "__main__":
    # Self-test: Siripuram AOI (streams live — needs internet + deps).
    _TEST_BBOX = [83.3130, 17.7180, 83.3245, 17.7280]
    print(f"[self-test] elevation for Siripuram {_TEST_BBOX}")
    generate_elevation_layer(_TEST_BBOX)
