# Elevation Engine — SIH PS 26011, Input #3 (Z-Axis Layer)

Builds `elevated_buildings.geojson` for any bbox: every building footprint
gets a ground anchor (`Z_base`), a fused structural height (`H_final`), and
full volumetric bounds (`Z_ground`, `Z_roof`, `Z_sub`) plus 3D `floor_slices`
ready for 3D ULPIN slicing. Sibling to `tif_generator` and `parcel_generator`,
same Kaggle Utility Script standard.

## Layout

- `ground.py` — Copernicus GLO-30 ground anchor: unsigned `/vsis3/` stream
  from `s3://copernicus-dem-30m` (eu-central-1, EGM2008 MSL), annulus ring
  sampling (8 m outer minus 2 m inner) so rooftops never corrupt the baseline
- `overture.py` — Overture buildings streaming: unsigned DuckDB `httpfs` +
  `spatial` over `s3://overturemaps-us-west-2` (us-west-2), bbox + envelope
  pushdown, latest release resolved at call time with pinned fallback
- `consensus.py` — robust height fusion: median + MAD, 3-sigma reject,
  Huber-reweighted inverse-variance fusion, LADM confidence + floor counts
- `pipeline.py` — facade: `generate_elevation_layer(...)` + CLI + Siripuram
  self-test block
- `requirements.txt` — minimal deps

## Decoupled Z-axis (why not DSM − DEM)

30 m satellite subtraction fails cadastral slicing: one 900 m² pixel smears
whole plots, ±3.5–5 m RMSE, 15-year lag. So the axis is decoupled:

- Macro ground (`Z_base`): Copernicus GLO-30 median on the annulus ring
  around each footprint (street/soil level, never the roof).
- Micro height (`H_final`): Overture direct height (σ 2.0) +
  floors × 3.0 m (σ 3.0) + typology prior (σ 4.5), fused with outlier
  rejection. No height anywhere → typology fallback, flagged low confidence.
- Bounds per building: `Z_ground = Z_base`, `Z_roof = Z_base + H_final`,
  `Z_sub = Z_base − 3.0` (1-level basement right), 3.0 m floor slices.

## Kaggle use

1. Upload this folder as a Utility Script (e.g. `elevation-engine`), attach it.
2. Cell:
   ```
   !pip install -q rasterio geopandas shapely pyproj duckdb requests numpy
   import sys; sys.path.insert(0, "/kaggle/input/elevation-engine")
   from pipeline import generate_elevation_layer
   gdf = generate_elevation_layer([83.3130, 17.7180, 83.3245, 17.7280])
   ```
   Output: `/kaggle/working/elevation/elevated_buildings.geojson` +
   `manifest.json` (EPSG:4326, `vertical_datum: EGM2008`).
   (If the mount nests files deeper, point sys.path at the folder that
   actually contains pipeline.py — same lesson as tif_generator.)
3. Single bash instead (no Python call):
   ```
   python /kaggle/input/elevation-engine/pipeline.py
   ```
   (Self-test runs the Siripuram AOI.)

## Local use

```
pip install -r requirements.txt
python pipeline.py --bbox 83.313,17.718,83.3245,17.728 --output_dir ./elevation
python pipeline.py --bbox ... --footprints <batch_infer --to-world GeoJSON> --output_dir ./elevation
```

## Rules enforced in code

- Zero keys, zero logins: Copernicus via unsigned `/vsis3/`, Overture via
  unsigned DuckDB S3 — full rasters are never downloaded, only streamed.
- Metric ops (buffers, annulus, areas) in local UTM derived from the bbox
  center; `area_m2` measured in UTM (3857 inflates areas — never bill from it).
- Ring collapse → centroid sample → 0.0: `Z_base` is never empty and never
  silent (low-confidence builds are flagged, not dropped).
- Overture bucket only keeps recent releases: the release id is resolved live
  via anonymous S3 listing, falling back to the pinned known-good release.
- Empty fetch (no buildings / offline) still writes a valid empty GeoJSON +
  manifest — downstream never crashes on missing input.
