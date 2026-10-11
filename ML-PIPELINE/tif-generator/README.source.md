# ML Data Ingestion Engine — SIH PS 26011

Fetches open aerial imagery for any bbox, stitches a georeferenced master
GeoTIFF (EPSG:3857), and slices sliding-window `.tif` tiles ready for YOLO
training. Built so notebooks never carry pipeline logic — one import, one call.

## Layout

- `map_fetcher.py` — Slippy (X, Y, Z) math + concurrent tile downloads (Esri World Imagery, no key)
- `tiler.py` — stitch to master, exact WebMercator affine, sliding-window slice with per-tile transforms
- `pipeline.py` — facade: `generate_drone_dataset(...)` + CLI
- `requirements.txt` — minimal deps

## Kaggle setup (Utility Script, no copy-paste)

1. Kaggle notebook → Add input → New Utility Script → upload this folder as `ml-pipeline`.
2. In your training notebook, attach it under Add input → `ml-pipeline`.
3. Cell 1 — deps + path:
   ```
   !pip install -q rasterio mercantile pillow tqdm requests numpy
   import sys; sys.path.insert(0, "/kaggle/input/ml-pipeline")
   ```
4. Cell 2 — run (Siripuram demo AOI):
   ```
   from pipeline import generate_drone_dataset
   out = generate_drone_dataset(
       bbox=[83.3130, 17.7180, 83.3245, 17.7280],
       zoom=19, tile_size=1024, overlap=0.2,
       output_dir="/kaggle/working/drone_tiles")
   ```
   Downstream training reads `/kaggle/working/drone_tiles/tiles/*.tif` +
   `tiles.json` (same `{file, x0, y0, transform[6], crs}` contract as
   `aeroview-ml/tile_geotiff.py`).

Or single bash (GPU notebooks, no Python call):
```
python /kaggle/input/ml-pipeline/pipeline.py \
  --bbox 83.313,17.718,83.3245,17.728 --zoom 19 \
  --tile_size 1024 --overlap 0.2 --output_dir /kaggle/working/drone_tiles
```

## Local use

```
pip install -r requirements.txt
python pipeline.py --bbox 83.313,17.718,83.3245,17.728 --zoom 17 \
  --tile_size 1024 --overlap 0.2 --output_dir ./drone_tiles
```

## Notes

- Zoom 19 over the full Siripuram bbox = 288 raw tiles (~4.6k px master, 0.30 m/px). Start at
  zoom 17 for smoke tests (a few dozen tiles).
- Downloads resume: existing `_raw/*.jpg` are skipped on re-run.
-imagery: Esri World Imagery, attribution required on slides
  ("Imagery © Esri & contributors").
- Master defaults to EPSG:3857 (native tile grid, zero resampling). Pass
  `crs="EPSG:4326"` only if you need lon/lat GeoTIFFs (needs rasterio).
