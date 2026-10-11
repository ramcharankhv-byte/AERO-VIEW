"""blocks.py — road centerlines -> city blocks (SIH PS 26011).

All geometry in a metric CRS (caller projects lon/lat first; use
to_metric() here). Steps: unary_union the network, polygonize against the
bbox frame (so edge blocks close), prune slivers under min_area_m2.

Returns block polygons in the SAME metric CRS. No degrees enter, no degrees
leave — buffering or area math in WGS84 is the classic silent-corruption bug.
"""

from __future__ import annotations

from shapely.geometry import LineString, box
from shapely.ops import polygonize, unary_union
from pyproj import Transformer

WGS84 = "EPSG:4326"
METRIC_DEFAULT = "EPSG:3857"


def to_metric(
    lonlat_geoms: list, src_crs: str = WGS84, dst_crs: str = METRIC_DEFAULT
) -> tuple[list, Transformer]:
    """Project shapely lon/lat geoms to metric. Returns (projected, transformer)."""
    tf = Transformer.from_crs(src_crs, dst_crs, always_xy=True)
    out = []
    for g in lonlat_geoms:
        out.append(
            LineString([(tf.transform(x, y)) for x, y in g.coords])
        )
    return out, tf


def build_blocks(
    road_lines_metric: list,
    bbox_metric: tuple[float, float, float, float],
    min_area_m2: float = 200.0,
) -> list:
    """Polygonize road network + bbox frame into blocks. Drops slivers.

    bbox_metric = (minx, miny, maxx, maxy) in metric units. The frame ring is
    mandatory — without it, blocks touching the bbox edge never close and the
    whole edge of the AOI becomes one un-split mega-block.
    """
    minx, miny, maxx, maxy = bbox_metric
    frame = box(minx, miny, maxx, maxy)
    network = unary_union(road_lines_metric + [frame.boundary])
    blocks = [
        p for p in polygonize(network)
        if p.is_valid and p.area >= min_area_m2 and frame.contains(p.representative_point())
    ]
    # bbox minus roads can leave valid ground polygonize misses if the network
    # is a single line; cover it: any frame area not in a block and above the
    # area floor becomes its own block.
    covered = unary_union(blocks) if blocks else None
    rest = frame if covered is None else frame.difference(covered)
    geoms = [rest] if rest.geom_type == "Polygon" else list(getattr(rest, "geoms", []))
    for g in geoms:
        if g.is_valid and g.area >= min_area_m2:
            blocks.append(g)
    return blocks
