"""Local hazard exposure per building, derived from the project's own DEM.

WHY THIS EXISTS. Bhuvan's flood and cyclone hazard layers are NATIONAL
products: over an AOI 1.2 km across they return a single polygon, so the
whole neighbourhood washes one flat colour and the map says nothing about
which streets are worse than which. That is a true statement about the
national dataset and a useless one for a cadastral viewer.

So this script derives a LOCAL exposure index from data the project already
holds -- the CartoDEM ground surface and the coastline visible in the same
tile -- and grades every building into four classes. It is DERIVED, not
surveyed: it carries provenance 'derived' everywhere it surfaces, the viewer
labels it as a terrain-derived index, and it never borrows NRSC's authority.
The Bhuvan zone stays on screen underneath it as the authoritative
national classification.

WHAT DRIVES EACH INDEX

  flood     0.45  low ground in absolute terms (surge and backwater reach)
            0.40  sitting in a LOCAL hollow -- ground minus the 20th
                  percentile of ground within 250 m. A building 8 m below
                  its neighbours takes their water; one on the local high
                  point does not, whatever its absolute height.
            0.15  proximity to the shoreline

  cyclone   0.50  proximity to the shoreline
            0.30  wind EXPOSURE -- the same local relief, opposite sign: a
                  ridge or a local high point is hit, a hollow is sheltered
            0.20  building height, as a stand-in for wind load on the
                  structure itself

The two are only weakly correlated (about -0.26 over Siripuram), which is the
point: the low sheltered ground that floods is not the exposed high ground
the wind hits.

CLASS BOUNDARIES are fixed scores, not quantiles, so a class means the same
thing in every project and adding an AOI cannot re-grade an existing one.

Requires the geo toolchain (rasterio + pyproj), like scripts/dem.py. Without
it, or without a DEM, every building is left unclassified and the viewer
offers no derived layer -- the Bhuvan zones still render.

    python scripts/hazard.py [--slug=... --name=... --bbox=...]
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dem as demmod  # noqa: E402
import project as proj  # noqa: E402

# How far out to look for the coastline. The AOI is 1-2 km across; the sea has
# to be inside the window or the distance term is meaningless.
COAST_SEARCH_DEG = 0.06
# Sea test: MSL below this. -1 m rather than 0 m so a beach cell or a metre of
# vertical error in the DEM does not read as ocean.
SEA_MSL_M = -1.0
# Radius for "the local ground around this building".
NEIGHBOURHOOD_M = 250.0
# The percentile of neighbouring ground that counts as the local floor.
LOCAL_FLOOR_PCT = 20

CLASSES = ("low", "moderate", "high", "severe")
# Upper bound of each class, on a 0..1 score.
BOUNDS = (0.35, 0.50, 0.65, 1.01)


def classify(score):
    for name, hi in zip(CLASSES, BOUNDS):
        if score < hi:
            return name
    return CLASSES[-1]


def _norm(v, lo, hi):
    if hi == lo:
        return 0.0
    return min(1.0, max(0.0, (v - lo) / (hi - lo)))


def _percentile(values, pct):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (pct / 100.0)
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def sea_points(p):
    """Lon/lat of every sea cell near the AOI, from the raw DEM tile.

    The raw tile rather than the clip: the clip is the bbox, and the coast is
    outside it. Returns [] when there is no raw tile or no sea in range --
    a landlocked AOI is a legitimate case, and the distance term drops out.
    """
    raw = p.dem_raw_path
    if not raw:
        return []
    try:
        import numpy as np
        import rasterio
        from rasterio import windows, transform as rtransform
    except ImportError:
        return []

    with rasterio.open(raw) as src:
        bounds = (p.west - COAST_SEARCH_DEG, p.south - COAST_SEARCH_DEG,
                  p.east + COAST_SEARCH_DEG, p.north + COAST_SEARCH_DEG)
        try:
            win = windows.from_bounds(*bounds, src.transform)
            arr = src.read(1, window=win)
            tr = src.window_transform(win)
        except (ValueError, rasterio.errors.RasterioError):
            return []
        nodata = src.nodata

    # The tile is ellipsoidal (see scripts/dem.py); the geoid separation at the
    # AOI centre converts the sea-level test into the tile's own units. One
    # value for the whole window: N changes by centimetres over 13 km.
    sep = 0.0
    if demmod.DEM_DATUM == "ellipsoidal":
        _, _, h = demmod._egm96_transformer().transform(p.lon0, p.lat0, 0.0)
        sep = -h

    mask = arr < (sep + SEA_MSL_M)
    if nodata is not None:
        # A void in the ocean is still ocean; CartoDEM leaves the sea as nodata.
        mask = mask | (arr == nodata)
    rows, cols = np.nonzero(mask)
    if len(rows) == 0:
        return []
    xs, ys = rtransform.xy(tr, rows, cols)
    return list(zip(np.asarray(xs), np.asarray(ys)))


def compute(p, features):
    """Attach flood/cyclone exposure to each feature. Returns a summary dict."""
    if not features:
        return None
    sea = sea_points(p)
    m_lat = proj.M_PER_DEG_LAT
    m_lon = p.m_per_deg_lon

    lons = [f["properties"]["lon"] for f in features]
    lats = [f["properties"]["lat"] for f in features]
    elevs = [f["properties"]["ground_elev"] for f in features]
    heights = [f["properties"]["height_m"] for f in features]

    try:
        import numpy as np
    except ImportError:
        return None

    lon = np.asarray(lons)
    lat = np.asarray(lats)
    el = np.asarray(elevs)
    ht = np.asarray(heights)

    if sea:
        sx = np.asarray([s[0] for s in sea])
        sy = np.asarray([s[1] for s in sea])
        coast = np.asarray([
            float(np.min(np.hypot((sx - a) * m_lon, (sy - b) * m_lat)))
            for a, b in zip(lon, lat)
        ])
    else:
        coast = None

    # Local relief: this building's ground against the local floor around it.
    x = (lon - p.lon0) * m_lon
    y = (lat - p.lat0) * m_lat
    relief = np.empty(len(features))
    for i in range(len(features)):
        near = el[np.hypot(x - x[i], y - y[i]) <= NEIGHBOURHOOD_M]
        relief[i] = el[i] - float(np.percentile(near, LOCAL_FLOOR_PCT))

    # Absolute spans, so a class means the same thing in every project.
    lo_el, hi_el = 10.0, 70.0
    lo_rel, hi_rel = 0.0, 12.0
    lo_relx, hi_relx = -2.0, 12.0
    lo_c, hi_c = 350.0, 1900.0
    lo_h, hi_h = 3.0, 30.0

    counts = {"flood": {c: 0 for c in CLASSES}, "cyclone": {c: 0 for c in CLASSES}}
    for i, f in enumerate(features):
        low_ground = 1.0 - _norm(el[i], lo_el, hi_el)
        hollow = 1.0 - _norm(relief[i], lo_rel, hi_rel)
        exposure = _norm(relief[i], lo_relx, hi_relx)
        tall = _norm(ht[i], lo_h, hi_h)
        if coast is not None:
            near_sea = 1.0 - _norm(coast[i], lo_c, hi_c)
            flood = 0.45 * low_ground + 0.40 * hollow + 0.15 * near_sea
            cyclone = 0.50 * near_sea + 0.30 * exposure + 0.20 * tall
        else:
            # No coastline in range: re-weight onto the terms that still mean
            # something rather than scoring a landlocked AOI as if it were dry.
            flood = 0.53 * low_ground + 0.47 * hollow
            cyclone = 0.60 * exposure + 0.40 * tall
        fc = classify(flood)
        cc = classify(cyclone)
        counts["flood"][fc] += 1
        counts["cyclone"][cc] += 1
        f["properties"].update({
            "flood_risk": fc,
            "flood_score": round(float(flood), 3),
            "cyclone_risk": cc,
            "cyclone_score": round(float(cyclone), 3),
            "coast_dist_m": (None if coast is None else round(float(coast[i]))),
            "local_relief_m": round(float(relief[i]), 1),
        })

    return {
        "model": "terrain_v1",
        "coastline": ("dem_sea_mask" if sea else None),
        "flood": counts["flood"],
        "cyclone": counts["cyclone"],
    }


def main():
    p = proj.parse_args()
    path = p.attributed_path
    if not os.path.exists(path):
        raise SystemExit(f"run scripts/02_heights.py first (no {path})")
    with open(path, encoding="utf-8") as fh:
        fc = json.load(fh)

    elevation = fc.get("elevation") or {}
    if elevation.get("elev_source") != demmod.ELEV_SOURCE:
        print("  no DEM-derived ground for this project; "
              "hazard exposure not computed (Bhuvan zones still render)")
        fc.pop("hazard", None)
        for f in fc["features"]:
            for k in ("flood_risk", "flood_score", "cyclone_risk", "cyclone_score",
                      "coast_dist_m", "local_relief_m"):
                f["properties"].pop(k, None)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(fc, fh)
        return

    summary = compute(p, fc["features"])
    if not summary:
        print("  hazard exposure needs numpy/rasterio; skipped")
        return
    fc["hazard"] = summary
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh)

    n = len(fc["features"])
    print(f"  hazard exposure ({summary['model']}) over {n} buildings, "
          f"coastline: {summary['coastline'] or 'none in range'}")
    for kind in ("flood", "cyclone"):
        row = "  ".join(f"{c}={summary[kind][c]}" for c in CLASSES)
        print(f"    {kind:<8} {row}")


if __name__ == "__main__":
    main()
