"""ground.py — Copernicus GLO-30 ground anchor (SIH 26011 Input 3).

Streams the 30 m Copernicus DSM COG straight from the AWS Open Data bucket
(s3://copernicus-dem-30m, eu-central-1) with no key, no login. Vertical
datum is EGM2008 orthometric (MSL metres) — matches the PS mandate.

Tile layout (1x1 deg, 10 m files are resampled 30 m products):
  Copernicus_DSM_COG_10_N<lat>_00_E<lon>_00_DEM/Copernicus_DSM_COG_10_N<lat>_00_E<lon>_00_DEM.tif
where <lat>/<lon> are the integer floor of the query point, zero-padded.
Example Siripuram (17.72, 83.31):
  Copernicus_DSM_COG_10_N17_00_E083_00_DEM/...

Kaggle use (flat utility script — both import styles work):
    from ground import open_copernicus_tile, robust_ground_sample
"""

from __future__ import annotations

import math
import os

COPERNICUS_BUCKET = "copernicus-dem-30m"
COPERNICUS_REGION = "eu-central-1"


def tile_key_for_lonlat(lon: float, lat: float) -> str:
    """Build the S3 key fragment for the 1x1 deg tile holding (lon, lat)."""
    lat_i = math.floor(lat)
    lon_i = math.floor(lon)
    ns = "N" if lat_i >= 0 else "S"
    ew = "E" if lon_i >= 0 else "W"
    name = f"Copernicus_DSM_COG_10_{ns}{abs(lat_i):02d}_00_{ew}{abs(lon_i):03d}_00_DEM"
    return f"{name}/{name}.tif"


def copernicus_vsis3_url(lon: float, lat: float) -> str:
    """GDAL /vsis3/ URL for the tile holding (lon, lat)."""
    return f"/vsis3/{COPERNICUS_BUCKET}/{tile_key_for_lonlat(lon, lat)}"


def open_copernicus_tile(lon: float, lat: float):
    """Open the Copernicus COG for (lon, lat). Caller must close via close_copernicus_tile.

    Sets AWS_NO_SIGN_REQUEST=YES and enters an unsigned rasterio Env with
    AWSSession(requester_pays=False) so headless Kaggle works keyless.
    Returns (src, env) — keep env alive while sampling, then close both.
    """
    os.environ["AWS_NO_SIGN_REQUEST"] = "YES"
    import rasterio
    from rasterio.session import AWSSession

    env = rasterio.Env(
        AWSSession(requester_pays=False),
        AWS_REGION=COPERNICUS_REGION,
        AWS_NO_SIGN_REQUEST="YES",
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        VSI_CACHE="YES",
    )
    env.__enter__()
    url = copernicus_vsis3_url(lon, lat)
    src = rasterio.open(url)
    src._gdal_env = env  # stash so caller can exit it
    return src, env


def close_copernicus_tile(src, env) -> None:
    """Close a tile opened with open_copernicus_tile."""
    try:
        src.close()
    finally:
        try:
            env.__exit__(None, None, None)
        except Exception:
            pass


def utm_epsg_for_lonlat(lon: float, lat: float) -> str:
    """Local UTM EPSG string for a lon/lat (metric ops + area)."""
    from pyproj.aoi import AreaOfInterest
    from pyproj.database import query_utm_crs_info

    info = query_utm_crs_info(
        datum_name="WGS 84",
        area_of_interest=AreaOfInterest(
            west_lon_degree=lon,
            south_lat_degree=lat,
            east_lon_degree=lon,
            north_lat_degree=lat,
        ),
    )
    return f"EPSG:{info[0].code}"


def _normalise_utm_crs(utm_crs: str | int) -> str:
    if isinstance(utm_crs, int):
        return f"EPSG:{utm_crs}"
    s = str(utm_crs).strip()
    return s if s.upper().startswith("EPSG:") else f"EPSG:{s}"


def robust_ground_sample(src, geom_utm, utm_crs: str | int, n_samples: int = 32) -> float:
    """Sample bare-earth Z_base around a footprint (annulus median).

    Builds an annulus ring (outer 8 m buffer minus inner 2 m buffer) in UTM
    so samples fall on street/soil around the building, never on its roof.
    Interpolates ``n_samples`` evenly spaced points along the ring perimeter,
    reprojects them to EPSG:4326 and queries ``src.sample([(lon, lat)])``.
    Returns the float median of finite values. Falls back to the centroid
    sample when the ring collapses, and to 0.0 when nothing is readable.

    Args:
        src: Open rasterio dataset (Copernicus COG, EGM2008 metres).
        geom_utm: Shapely geometry of the building footprint in metric UTM.
        utm_crs: Source CRS of ``geom_utm`` (e.g. "EPSG:32644" or 32644).
        n_samples: Number of evenly spaced ring samples (default 32).
    """
    import numpy as np
    from pyproj import Transformer

    def _finite(v: object) -> bool:
        try:
            f = float(v)  # type: ignore[arg-type]
        except Exception:
            return False
        return bool(np.isfinite(f)) and -50.0 < f < 9000.0

    utm_str = _normalise_utm_crs(utm_crs)

    def _sample_lonlat(lonlat: list[tuple[float, float]]) -> list[float]:
        try:
            vals = [v[0] for v in src.sample(lonlat)]
        except Exception:
            return []
        return [float(v) for v in vals if _finite(v)]

    # --- annulus ring: never sample the rooftop ---
    try:
        if geom_utm is None or geom_utm.is_empty:
            raise ValueError("empty footprint geometry")
        outer = geom_utm.buffer(8.0, resolution=16)
        inner = geom_utm.buffer(2.0, resolution=16)
        ring = outer.difference(inner)
        if ring.is_empty:
            raise ValueError("empty ring")
        if not ring.is_valid:
            ring = ring.buffer(0)
            if ring.is_empty:
                raise ValueError("invalid ring")
        boundary = ring.boundary
        if boundary.is_empty or float(boundary.length) <= 0:
            raise ValueError("empty ring boundary")
        total = float(boundary.length)
        n = max(int(n_samples), 1)
        pts_utm = [boundary.interpolate((i + 0.5) / n * total) for i in range(n)]
        xy = [(float(p.x), float(p.y)) for p in pts_utm]
        tf = Transformer.from_crs(utm_str, "EPSG:4326", always_xy=True)
        lonlat = [tf.transform(x, y) for x, y in xy]
        samples = _sample_lonlat(lonlat)
        if samples:
            return float(np.median(np.array(samples, dtype=float)))
        raise ValueError("no valid ring samples")
    except Exception:
        pass

    # --- fallback: centroid sample ---
    try:
        c = geom_utm.centroid
        tf = Transformer.from_crs(utm_str, "EPSG:4326", always_xy=True)
        lon, lat = tf.transform(float(c.x), float(c.y))
        vals = _sample_lonlat([(lon, lat)])
        if vals:
            return float(vals[0])
    except Exception:
        pass
    return 0.0
