"""tiler.py — stitch Slippy tiles -> master GeoTIFF -> sliding-window .tif tiles.

WebMercator (EPSG:3857) constants: R = 6378137, C = 2*pi*R.
Tile span (m) at zoom z = C / 2**z. Resolution = span / 256.

Master top-left for tile range (xmin..xmax, ymin..ymax):
  left = xmin * span - C/2
  top  = C/2 - ymin * span
Affine (6 params, CRS units): (res, 0, left, 0, -res, top).
Tile (x0,y0) world transform = base shifted by pixel origin —
same convention as aeroview-ml/tile_geotiff.py:
  c' = c + x0*a + y0*b ; f' = f + x0*d + y0*e
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

R_EARTH = 6378137.0
CIRCUMFERENCE = 2.0 * math.pi * R_EARTH
TILE_PX = 256
MIN_TILE_PX = 256  # skip edge slivers below this (matches tile_geotiff.py)


def tile_span_m(zoom: int) -> float:
    return CIRCUMFERENCE / (1 << zoom)


def master_affine(
    xmin: int, ymin: int, zoom: int
) -> tuple[float, float, float, float, float, float]:
    """6-param affine (a,b,c,d,e,f) for the master image top-left in EPSG:3857."""
    span = tile_span_m(zoom)
    res = span / TILE_PX
    left = xmin * span - CIRCUMFERENCE / 2.0
    top = CIRCUMFERENCE / 2.0 - ymin * span
    return (res, 0.0, left, 0.0, -res, top)


def stitch_tiles(
    cache_dir: str | Path,
    tiles: list[tuple[int, int]],
    xrange: tuple[int, int, int, int],
    zoom: int,
) -> np.ndarray:
    """Paste cached {z}_{x}_{y}.jpg tiles into one RGB master array (H, W, 3).

    Raises FileNotFoundError listing missing tiles (download step incomplete).
    """
    xmin, ymin, xmax, ymax = xrange
    nx, ny = xmax - xmin + 1, ymax - ymin + 1
    master = np.full((ny * TILE_PX, nx * TILE_PX, 3), 255, dtype=np.uint8)
    missing = []
    for x, y in tiles:
        p = Path(cache_dir) / f"{zoom}_{x}_{y}.jpg"
        if not p.exists():
            missing.append(p.name)
            continue
        img = Image.open(p).convert("RGB").resize((TILE_PX, TILE_PX))
        ox, oy = (x - xmin) * TILE_PX, (y - ymin) * TILE_PX
        master[oy : oy + TILE_PX, ox : ox + TILE_PX] = np.asarray(img)
    if missing:
        raise FileNotFoundError(
            f"{len(missing)} tiles missing in {cache_dir}: {missing[:5]}..."
        )
    return master


def write_master_geotiff(
    master: np.ndarray, affine6: tuple, crs: str, dest: str | Path
) -> Path:
    """Write master RGB array to GeoTIFF (needs rasterio). Returns path."""
    try:
        import rasterio
        from rasterio.crs import CRS
    except ImportError:
        raise ImportError("rasterio required for master GeoTIFF output")
    from rasterio.transform import Affine as RAffine

    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    a, b, c, d, e, f = affine6
    h, w = master.shape[:2]
    with rasterio.open(
        dest,
        "w",
        driver="GTiff",
        width=w,
        height=h,
        count=3,
        dtype="uint8",
        crs=CRS.from_string(crs),
        transform=RAffine(a, b, c, d, e, f),
        compress="deflate",
        tiled=True,
    ) as r:
        for i in range(3):
            r.write(master[:, :, i], i + 1)
    return dest


def slice_windows(
    master: np.ndarray,
    affine6: tuple,
    crs: str,
    out_dir: str | Path,
    stem: str,
    tile_size: int = 1024,
    overlap: float = 0.2,
) -> list[dict]:
    """Sliding-window slice of master into standalone .tif tiles + metadata list.

    Each entry: {file, x0, y0, transform[6], size}. Edge windows are
    white-padded to full tile_size; windows < 256px on either side are skipped
    (matches tile_geotiff.py sliver rule). Transform per tile uses the
    shift-by-origin convention.
    """
    try:
        import rasterio
        from rasterio.crs import CRS
        from rasterio.transform import Affine as RAffine

        has_rio = True
    except ImportError:
        has_rio = False

    if not (0.0 <= overlap < 1.0):
        raise ValueError(f"overlap must be in [0, 1): {overlap}")
    if tile_size < MIN_TILE_PX:
        raise ValueError(f"tile_size {tile_size} < minimum {MIN_TILE_PX}")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    H, W = master.shape[:2]
    step = max(1, int(tile_size * (1.0 - overlap)))
    a, b, c, d, e, f = affine6

    metas = []
    for y0 in range(0, H, step):
        for x0 in range(0, W, step):
            w, h = min(tile_size, W - x0), min(tile_size, H - y0)
            if w < MIN_TILE_PX or h < MIN_TILE_PX:
                continue
            win = master[y0 : y0 + h, x0 : x0 + w]
            if (w, h) != (tile_size, tile_size):
                pad = np.full((tile_size, tile_size, 3), 255, dtype=np.uint8)
                pad[:h, :w] = win
                win = pad
            name = f"{stem}_{x0}_{y0}.tif"
            ta, tb, tc, td, te, tf = (
                a,
                b,
                c + x0 * a + y0 * b,
                d,
                e,
                f + x0 * d + y0 * e,
            )
            if has_rio:
                with rasterio.open(
                    out / name,
                    "w",
                    driver="GTiff",
                    width=tile_size,
                    height=tile_size,
                    count=3,
                    dtype="uint8",
                    crs=CRS.from_string(crs),
                    transform=RAffine(ta, tb, tc, td, te, tf),
                    compress="deflate",
                    tiled=True,
                ) as r:
                    for i in range(3):
                        r.write(win[:, :, i], i + 1)
            else:
                Image.fromarray(win).save(out / name)
            metas.append(
                {
                    "file": name,
                    "x0": x0,
                    "y0": y0,
                    "transform": [ta, tb, tc, td, te, tf],
                    "size": [tile_size, tile_size],
                }
            )
    meta_path = out.parent / "tiles.json"
    meta_path.write_text(
        json.dumps({"crs": crs, "affine": list(affine6), "tiles": metas}, indent=1)
    )
    return metas
