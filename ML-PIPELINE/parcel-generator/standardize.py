"""standardize.py — Tier 1 BYOD cadastral loader (SIH PS 26011).

Accepts any user-supplied parcel GeoJSON: detects source CRS (explicit
crs member wins, else degree-range heuristic), reprojects to the metric CRS,
repairs with buffer(0), enforces unique string parcel_ids.

NOTE: AERO-VIEW ships no parcel ground truth. data/raw_buildings.geojson is
385 WGS84 *building* footprints, not parcels. This slot is for real register
data when the team obtains it — until then Tier 2 (OSM + Voronoi) is the
default path, and its output stays flagged synthetic.
"""

from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import shape, mapping
from shapely.ops import transform as shp_transform
from pyproj import Transformer

WGS84 = "EPSG:4326"


def detect_src_crs(fc: dict) -> str:
    if isinstance(fc.get("crs"), dict):
        name = fc["crs"].get("properties", {}).get("name", "")
        return "EPSG:3857" if "3857" in name else "EPSG:4326"
    # heuristic: first coordinate pair in degree range -> WGS84.
    # (Unambiguous for Indian AOIs: 3857 eastings are ~9M, never <= 180.)
    for f in fc.get("features", []):
        try:
            g = f["geometry"]
            c = g["coordinates"]
            while isinstance(c[0], (list, tuple)):
                c = c[0]
            x, y = float(c[0]), float(c[1])
            return WGS84 if abs(x) <= 180 and abs(y) <= 90 else "EPSG:3857"
        except Exception:
            continue
    return WGS84


def standardize(
    src: str | Path,
    dst_crs: str = "EPSG:3857",
    id_prop: str = "parcel_id",
    synthetic: bool = False,
) -> list[dict]:
    """Load BYOD parcels -> repaired metric parcel records (same shape as Tier 2)."""
    fc = json.loads(Path(src).read_text())
    src_crs = detect_src_crs(fc)
    tf = Transformer.from_crs(src_crs, dst_crs, always_xy=True) if src_crs != dst_crs else None

    out, seen = [], set()
    for i, f in enumerate(fc.get("features", [])):
        try:
            g = shape(f["geometry"])
        except Exception:
            continue
        if g.is_empty:
            continue
        if tf is not None:
            g = shp_transform(lambda x, y: tf.transform(x, y), g)
        if not g.is_valid:
            g = g.buffer(0)
        if g.is_empty or not g.is_valid:
            continue
        pid = str(f.get("properties", {}).get(id_prop, f"BYOD-{i + 1:04d}"))
        if pid in seen:
            pid = f"{pid}#{i}"
        seen.add(pid)
        geoms = [g] if g.geom_type == "Polygon" else [
            p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"
        ]
        for k, poly in enumerate(geoms):
            out.append({
                "parcel_id": pid if len(geoms) == 1 else f"{pid}.{k + 1}",
                "geometry": poly,
                "area_m2": 0.0,  # filled by pipeline (needs UTM)
                "status": "byod",
                "setback_m": 0.0,
                "setback_skipped": True,
                "synthetic": synthetic,
            })
    # geometries only (properties re-attached at export)
    return out
