"""map_fetcher.py — bbox -> Slippy tiles -> downloaded aerial images (SIH PS 26011).

Pure stdlib tile math (verified against mercantile when installed), plus
concurrent downloads from open aerial endpoints (default Esri World Imagery).

Tile convention: Slippy / XYZ, origin top-left, x in [0, 2**z), y in [0, 2**z).
  n = 2 ** zoom
  xtile = floor((lon + 180) / 360 * n)
  ytile = floor((1 - ln(tan(lat_rad) + sec(lat_rad)) / pi) / 2 * n)

Endpoint default (no key):
  https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
"""

from __future__ import annotations

import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from tqdm import tqdm

ESRI_WORLD_IMAGERY = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery"
    "/MapServer/tile/{z}/{y}/{x}"
)

TILE_PX = 256
_USER_AGENT = "AERO-VIEW-ml-pipeline/1.0 (SIH-26011; contact: local research use)"


def lonlat_to_tile(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    """Lon/lat (degrees) -> (xtile, ytile). Clamps latitude to WebMercator limits."""
    if not (-180.0 <= lon <= 180.0):
        raise ValueError(f"lon out of range: {lon}")
    lat = max(min(lat, 85.05112878), -85.05112878)
    n = 1 << zoom
    xtile = int(math.floor((lon + 180.0) / 360.0 * n))
    lat_rad = math.radians(lat)
    ytile = int(
        math.floor(
            (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi)
            / 2.0
            * n
        )
    )
    return (min(max(xtile, 0), n - 1), min(max(ytile, 0), n - 1))


def tiles_for_bbox(
    bbox: tuple[float, float, float, float], zoom: int
) -> tuple[list[tuple[int, int]], tuple[int, int, int, int]]:
    """Tiles covering bbox. Returns (tile_list, (xmin, ymin, xmax, ymax)) inclusive.

    bbox = (min_lon, min_lat, max_lon, max_lat). Raises on bad order,
    zero-area, or antimeridian crossing (split the bbox instead).
    """
    min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox)
    if not (min_lon < max_lon and min_lat < max_lat):
        raise ValueError(f"bad bbox order/area: {bbox}")
    if min_lon < -180 or max_lon > 180 or min_lat < -85.0511 or max_lat > 85.0511:
        raise ValueError(f"bbox outside WebMercator limits: {bbox}")
    # Antimeridian: min > max in tile space is ambiguous — refuse, caller splits.
    x0, y_top = lonlat_to_tile(min_lon, max_lat, zoom)  # NW corner
    x1, y_bot = lonlat_to_tile(max_lon, min_lat, zoom)  # SE corner
    if x1 < x0:  # crosses 180th meridian
        raise ValueError("bbox crosses antimeridian; split into two bboxes")
    tiles = [(x, y) for y in range(y_top, y_bot + 1) for x in range(x0, x1 + 1)]
    return tiles, (x0, y_top, x1, y_bot)


def verify_against_mercantile(bbox, zoom) -> None:
    """Cross-check our math with mercantile (if installed). Raises on mismatch."""
    try:
        import mercantile
    except ImportError:
        return  # pure-math mode, nothing to check against
    min_lon, min_lat, max_lon, max_lat = bbox
    mine, _ = tiles_for_bbox(bbox, zoom)
    theirs = list(mercantile.tiles(min_lon, min_lat, max_lon, max_lat, [zoom]))
    ref = sorted((t.x, t.y) for t in theirs)
    if sorted(mine) != ref:
        raise AssertionError(
            f"tile math mismatch: ours={sorted(mine)[:5]}... mercantile={ref[:5]}..."
        )


def _fetch_one(
    session: requests.Session, url: str, dest: Path, retries: int, timeout: int
) -> bool:
    for attempt in range(retries + 1):
        try:
            r = session.get(url, timeout=timeout)
            if r.status_code == 200 and r.content:
                dest.write_bytes(r.content)
                return True
            time.sleep(0.5 * (attempt + 1))
        except requests.RequestException:
            time.sleep(0.5 * (attempt + 1))
    return False


def download_tiles(
    tiles: list[tuple[int, int]],
    zoom: int,
    cache_dir: str | Path,
    tile_url: str = ESRI_WORLD_IMAGERY,
    workers: int = 8,
    retries: int = 3,
    timeout: int = 30,
    skip_existing: bool = True,
) -> dict:
    """Download every (x, y) tile at zoom into cache_dir/{z}_{x}_{y}.jpg.

    Returns {downloaded, skipped, failed, failed_tiles}.
    Polite: one shared Session, bounded workers, retry with backoff.
    """
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update({"User-Agent": _USER_AGENT})

    jobs = []
    skipped = 0
    for x, y in tiles:
        dest = cache / f"{zoom}_{x}_{y}.jpg"
        if skip_existing and dest.exists() and dest.stat().st_size > 0:
            skipped += 1
            continue
        jobs.append((x, y, dest))

    ok, failed_tiles = 0, []
    if jobs:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            futs = {
                ex.submit(
                    _fetch_one,
                    session,
                    tile_url.format(z=zoom, x=x, y=y),
                    dest,
                    retries,
                    timeout,
                ): (x, y)
                for x, y, dest in jobs
            }
            for fut in tqdm(as_completed(futs), total=len(futs), desc="tiles"):
                x, y = futs[fut]
                if fut.result():
                    ok += 1
                else:
                    failed_tiles.append((x, y))
    return {
        "downloaded": ok,
        "skipped": skipped,
        "failed": len(failed_tiles),
        "failed_tiles": failed_tiles,
    }
