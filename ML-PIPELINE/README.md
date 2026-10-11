# ML-PIPELINE — Aero View ML (SIH)

Kaggle notebook: https://www.kaggle.com/code/yellapusomeshwar/aeroview-ml
Author ML work: Yellapu Someshwar (`Someshwar-prox`)

End-to-end ML / geospatial pipeline backing AERO-VIEW demo AOIs:
Siripuram (Visakhapatnam), Banjara Hills (Hyderabad), BKC Mumbai.

## Layout

- `aeroview-ml.ipynb` — master run: drone tiles → parcels → elevation → YOLO / LiDAR
- `tif-generator/` — Esri World Imagery fetch, master GeoTIFF stitch, 1024px tiled windows (`map_fetcher.py`, `tiler.py`, `pipeline.py`)
- `parcel-generator/` — OSM roads → blocks → Voronoi parcel split, Siripuram snapshot (`osm_fetch.py`, `blocks.py`, `parcels.py`, `standardize.py`, `pipeline.py`)
- `elevation-engine/` — Copernicus GLO-30 ground + Overture height consensus + YOLOv8-seg footprints + PointNet LiDAR (`pipeline.py`, `ground.py`, `overture.py`, `consensus.py`, `ai_perception_engine.py`, `lidar_engine.py`)

## Run (Kaggle)

```python
import sys
sys.path.insert(0, "/kaggle/input/datasets/yellapusomeshwar/tif-generator")
from pipeline import generate_drone_dataset
generate_drone_dataset(bbox=[83.3130, 17.7180, 83.3245, 17.7280], zoom=19, tile_size=1024, overlap=0.2, output_dir="/kaggle/working/Siripuram_Map_Tiles")
```

```python
sys.path.insert(0, "/kaggle/input/datasets/yellapusomeshwar/parcel-generator")
from pipeline import generate_parcel_layer
generate_parcel_layer(bbox=[83.3130, 17.7180, 83.3245, 17.7280], output_dir="/kaggle/working/parcels")
```

```python
from pipeline import generate_elevation_layer
generate_elevation_layer([83.3130, 17.7180, 83.3245, 17.7280])
```

See `DATA_NOTES.md` for point-cloud inputs (kept on Kaggle, not in git).
