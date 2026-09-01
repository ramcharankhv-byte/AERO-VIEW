"""Shared AOI constants and a local metric projection.

The AOI is small (~1.2 x 1.1 km), so an equirectangular projection anchored at
the AOI centre is accurate to well under a metre here -- fine for the area and
height heuristics in 02_heights.py. All *authoritative* metric geometry is
still built in EPSG:32644 inside PostGIS; this is only for the estimator.
"""
import math

# Siripuram, Visakhapatnam
BBOX = (83.3130, 17.7180, 83.3245, 17.7280)   # west, south, east, north
AOI_NAME = "Siripuram, Visakhapatnam"
WEST, SOUTH, EAST, NORTH = BBOX
LAT0 = (SOUTH + NORTH) / 2.0
LON0 = (WEST + EAST) / 2.0

# Overpass wants (south, west, north, east)
OVERPASS_BBOX = f"{SOUTH},{WEST},{NORTH},{EAST}"

M_PER_DEG_LAT = 110574.0
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(LAT0))

DEFAULT_GROUND_ELEV = 12.0
FLOOR_HEIGHT = 3.2


def to_local(lon, lat):
    """lon/lat degrees -> metres east/north of the AOI centre."""
    return ((lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT)


def ring_area_m2(coords):
    """Shoelace area in m^2 for a lon/lat ring."""
    pts = [to_local(x, y) for x, y in coords]
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
