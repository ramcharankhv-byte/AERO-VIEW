"""Back-compatible AOI constants for the demo project.

The AOI is no longer a constant: it is a project, and scripts/project.py owns
it. This module survives so that the demo project's numbers are still stated
somewhere obvious, and so that anything reaching for `BBOX` or `AOI_NAME` gets
siripuram rather than an ImportError.

New code should take a `Project` and use its methods -- `p.ring_area_m2(ring)`,
`p.to_local(lon, lat)`, `p.overpass_bbox` -- because those are correct for
whichever AOI is being seeded. The module-level values here are correct only
for siripuram, which is exactly the assumption multi-project support removes.
"""
from project import (  # noqa: F401  (re-exported on purpose)
    DEFAULT_GROUND_ELEV,
    FLOOR_HEIGHT,
    M_PER_DEG_LAT,
    default_project,
)

_P = default_project()

BBOX = _P.bbox                      # west, south, east, north
AOI_NAME = _P.name
WEST, SOUTH, EAST, NORTH = BBOX
LAT0 = _P.lat0
LON0 = _P.lon0

# Overpass wants (south, west, north, east)
OVERPASS_BBOX = _P.overpass_bbox

M_PER_DEG_LON = _P.m_per_deg_lon


def to_local(lon, lat):
    """lon/lat degrees -> metres east/north of the demo AOI's centre."""
    return _P.to_local(lon, lat)


def ring_area_m2(coords):
    """Shoelace area in m^2 for a lon/lat ring, in the demo AOI's projection."""
    return _P.ring_area_m2(coords)
