"""pipeline.py — one-call drone dataset generator (SIH PS 26011).

Notebook use (Kaggle Utility Script attached as `ml_pipeline`):
    import sys; sys.path.insert(0, "/kaggle/input/ml-pipeline")
    from ml_pipeline.pipeline import generate_drone_dataset
    out = generate_drone_dataset(
        bbox=[83.3130, 17.7180, 83.3245, 17.7280],  # Siripuram demo AOI
        zoom=19, tile_size=1024, overlap=0.2,
        output_dir="/kaggle/working/drone_tiles")

CLI use:
    python -m ml_pipeline.pipeline --bbox 83.313,17.718,83.3245,17.728 \\
        --zoom 19 --tile_size 1024 --overlap 0.2 --output_dir ./drone_tiles
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:  # package import (folder on path as `ml_pipeline`)
    from .map_fetcher import (
        ESRI_WORLD_IMAGERY,
        download_tiles,
        tiles_for_bbox,
        verify_against_mercantile,
    )
    from .tiler import master_affine, slice_windows, stitch_tiles, write_master_geotiff
except ImportError:  # top-level import (folder itself on path, hyphenated name)
    from map_fetcher import (
        ESRI_WORLD_IMAGERY,
        download_tiles,
        tiles_for_bbox,
        verify_against_mercantile,
    )
    from tiler import master_affine, slice_windows, stitch_tiles, write_master_geotiff

DEFAULT_OUTPUT_DIR = "/kaggle/working/drone_tiles"
DEFAULT_CRS = "EPSG:3857"


def parse_bbox(s: str) -> tuple[float, float, float, float]:
    parts = [float(v.strip()) for v in s.split(",")]
    if len(parts) != 4:
        raise ValueError("--bbox needs 4 values: min_lon,min_lat,max_lon,max_lat")
    return (parts[0], parts[1], parts[2], parts[3])


def generate_drone_dataset(
    bbox: list[float] | tuple[float, float, float, float],
    zoom: int = 19,
    tile_size: int = 1024,
    overlap: float = 0.2,
    output_dir: str = DEFAULT_OUTPUT_DIR,
    tile_url: str = ESRI_WORLD_IMAGERY,
    workers: int = 8,
    crs: str = DEFAULT_CRS,
    write_master: bool = True,
) -> dict:
    """Fetch aerial tiles for bbox, stitch master GeoTIFF, slice .tif windows.

    Returns {output_dir, master, tiles_json, n_raw, n_windows, zoom, bbox,
             crs, affine, failed}. All heavy work stays inside this module.
    """
    bbox_t = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    if not (1 <= zoom <= 23):
        raise ValueError(f"zoom {zoom} outside [1, 23]")
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    tiles, xrange = tiles_for_bbox(bbox_t, zoom)
    verify_against_mercantile(bbox_t, zoom)  # no-op if mercantile missing

    cache = out / "_raw"
    dl = download_tiles(tiles, zoom, cache, tile_url=tile_url, workers=workers)
    if dl["failed"]:
        raise RuntimeError(
            f"{dl['failed']} tiles failed: {dl['failed_tiles'][:5]}... "
            "re-run (skip_existing resumes) or lower --workers"
        )

    master = stitch_tiles(cache, tiles, xrange, zoom)
    affine6 = master_affine(xrange[0], xrange[1], zoom)

    master_path = None
    if write_master:
        try:
            master_path = str(
                write_master_geotiff(master, affine6, crs, out / "master.tif")
            )
        except ImportError:
            # rasterio missing: save plain PNG + sidecar (still usable, not GIS-tagged)
            from PIL import Image

            Image.fromarray(master).save(out / "master.png")
            (out / "master_affine.json").write_text(
                json.dumps({"affine": list(affine6), "crs": crs})
            )
            master_path = str(out / "master.png")

    windows_dir = out / "tiles"
    metas = slice_windows(
        master, affine6, crs, windows_dir, stem="drone",
        tile_size=tile_size, overlap=overlap,
    )
    manifest = {
        "output_dir": str(out),
        "master": master_path,
        "tiles_json": str(windows_dir.parent / "tiles.json"),
        "n_raw": len(tiles),
        "n_windows": len(metas),
        "zoom": zoom,
        "bbox": list(bbox_t),
        "crs": crs,
        "affine": list(affine6),
        "tile_size": tile_size,
        "overlap": overlap,
        "failed": 0,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(
        f"[done] {len(tiles)} raw tiles (z{zoom}) -> "
        f"{len(metas)} windows ({tile_size}px, overlap {overlap}) -> {out}"
    )
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate drone training tiles for a bbox")
    ap.add_argument("--bbox", required=True,
                    help="min_lon,min_lat,max_lon,max_lat (e.g. 83.313,17.718,83.3245,17.728)")
    ap.add_argument("--zoom", type=int, default=19)
    ap.add_argument("--tile_size", type=int, default=1024)
    ap.add_argument("--overlap", type=float, default=0.2)
    ap.add_argument("--output_dir", default=DEFAULT_OUTPUT_DIR)
    ap.add_argument("--tile_url", default=ESRI_WORLD_IMAGERY)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--crs", default=DEFAULT_CRS)
    ap.add_argument("--no-master", action="store_true",
                    help="skip master.tif, write window tiles only")
    args = ap.parse_args(argv)
    generate_drone_dataset(
        bbox=parse_bbox(args.bbox),
        zoom=args.zoom,
        tile_size=args.tile_size,
        overlap=args.overlap,
        output_dir=args.output_dir,
        tile_url=args.tile_url,
        workers=args.workers,
        crs=args.crs,
        write_master=not args.no_master,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
