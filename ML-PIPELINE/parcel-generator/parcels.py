"""parcels.py — blocks -> cadastral parcels via bounded Voronoi (SIH PS 26011).

ALL inputs/outputs metric (normally EPSG:3857). area_m2 is measured in local
UTM (3857 inflates areas ~10% at Indian latitudes — never bill from it).

Per block:
  inner = block inset by setback_m (road reserve). Empty after inset ->
      keep unbuffered + flag (never emit empty geometry).
  0 seeds -> one VACANT parcel (coverage stays complete).
  1 seed  -> parcel = inner (Voronoi needs >= 2 points; skipping is correct,
             not a hack).
  >= 2    -> voronoi_diagram clipped to inner, seed-less slivers merged to
             the nearest seeded cell.

Every parcel: unique string parcel_id, area_m2, "synthetic": True.
Synthetic = geometric guess, not a surveyed record. parcel_gate.py verdicts
on these are self-consistency checks, not legal truth.
"""

from __future__ import annotations

from shapely.geometry import MultiPoint, mapping
from shapely.ops import unary_union, voronoi_diagram
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from pyproj.database import query_utm_crs_info


def utm_epsg(lon: float, lat: float) -> str:
    """Local UTM EPSG for a lon/lat (area-accurate measurements)."""
    info = query_utm_crs_info(
        datum_name="WGS 84",
        area_of_interest=AreaOfInterest(
            west_lon_degree=lon, south_lat_degree=lat,
            east_lon_degree=lon, north_lat_degree=lat,
        ),
    )
    return f"EPSG:{info[0].code}"


def area_m2_utm(geom_metric, metric_crs: str, utm: str) -> float:
    import math
    tf = Transformer.from_crs(metric_crs, utm, always_xy=True)
    g = geom_metric
    if g.geom_type == "Polygon":
        from shapely.geometry import Polygon as _P
        exterior = [tf.transform(x, y) for x, y in g.exterior.coords]
        holes = [[tf.transform(x, y) for x, y in r.coords] for r in g.interiors]
        flat = [v for p in exterior for v in p]
        if all(math.isfinite(v) for v in flat):
            return float(_P(exterior, holes).area)
        # far outside the UTM zone (e.g. synthetic Null Island coords):
        # fall back to native metric area rather than inf/nan.
    return round(float(g.area), 1)


def split_block(
    block,
    seeds: list,
    block_idx: int,
    setback_m: float = 2.5,
    metric_crs: str = "EPSG:3857",
    utm: str = "EPSG:32644",
    min_area_m2: float = 20.0,
) -> list[dict]:
    """Split one block into parcel records (metric shapely geoms)."""
    inner = block.buffer(-setback_m)
    setback_ok = True
    if inner.is_empty or inner.area < min_area_m2:
        inner = block  # narrow block: setback would erase it
        setback_ok = False
    inside = [s for s in seeds if inner.contains(s)]
    parcels: list[tuple] = []  # (geom, seed_or_None)

    if len(inside) == 0:
        parcels = [(inner, None)]
    elif len(inside) == 1:
        parcels = [(inner, inside[0])]
    else:
        regions = list(voronoi_diagram(MultiPoint(inside), envelope=inner).geoms)
        cells = [r.intersection(inner) for r in regions]
        cells = [c for c in cells if not c.is_empty and c.area > 0]
        owned: dict[int, list] = {id(s): [] for s in inside}
        orphans: list = []
        for c in cells:
            hit = next((s for s in inside if c.contains(s)), None)
            (owned[id(hit)].append(c) if hit is not None else orphans.append(c))
        merged: list[tuple] = []
        for s in inside:
            parts = owned[id(s)]
            merged.append((unary_union(parts) if parts else s.buffer(0.5), s))
        for frag in orphans:  # seed-less sliver -> nearest seeded cell
            best = min(merged, key=lambda t: frag.distance(t[1]))
            idx = merged.index(best)
            merged[idx] = (unary_union([best[0], frag]), best[1])
        parcels = merged

    out = []
    for seq, (geom, seed) in enumerate(parcels, 1):
        if geom.is_empty or geom.area < 1e-6:
            continue
        if not geom.is_valid:
            geom = geom.buffer(0)
        geoms = (
            [geom] if geom.geom_type == "Polygon"
            else [g for g in getattr(geom, "geoms", []) if g.geom_type == "Polygon"]
        )
        for g in geoms:
            if g.area < min_area_m2 and len(geoms) > 1:
                continue  # drop sub-floor sliver from a split piece
            out.append({
                "parcel_id": f"SY-{block_idx:03d}/{seq}",
                "geometry": g,
                "area_m2": round(area_m2_utm(g, metric_crs, utm), 1),
                "status": "occupied" if seed is not None else "vacant",
                "setback_m": setback_m if setback_ok else 0.0,
                "setback_skipped": not setback_ok,
                "synthetic": True,
            })
    return out


def grid_fallback_parcels(
    bbox_metric: tuple[float, float, float, float],
    block_idx_start: int,
    cell_m: float = 50.0,
    metric_crs: str = "EPSG:3857",
    utm: str = "EPSG:32644",
) -> list[dict]:
    """No-road fallback: regular grid clipped to bbox. Flagged honestly."""
    from shapely.geometry import box as _box
    minx, miny, maxx, maxy = bbox_metric
    out, i = [], block_idx_start
    x = minx
    while x < maxx:
        y = miny
        while y < maxy:
            cell = _box(x, y, min(x + cell_m, maxx), min(y + cell_m, maxy))
            out.append({
                "parcel_id": f"SY-{i:03d}/1",
                "geometry": cell,
                "area_m2": round(area_m2_utm(cell, metric_crs, utm), 1),
                "status": "vacant",
                "setback_m": 0.0,
                "setback_skipped": True,
                "synthetic": True,
                "source": "grid-fallback",
            })
            i += 1
            y += cell_m
        x += cell_m
    return out
