# Parcel Generator — SIH PS 26011, Input #2 (GIS Parcel Layer)

Builds `parcels.geojson` for any bbox, formatted so `parcel_gate.py` ingests
it directly (geometry + unique `parcel_id`). Sibling to `tif_generator`,
same Kaggle Utility Script standard.

## Two tiers + Siripuram shortcut

- Tier 1 BYOD: you supply a register GeoJSON (`--byod`). Reprojected to
  EPSG:3857, repaired with `buffer(0)`, IDs enforced unique.
- Siripuram shortcut: bbox exactly [83.313, 17.718, 83.3245, 17.728] with no
  `--byod` auto-loads Ramcharan's vendored snapshot (siripuram_parcels.geojson
  flat in this folder — Kaggle uploads skip subfolders, 326 parcels,
  real AP-VSP-3D26-* ULPINs as parcel_id). Mocked demo data — flagged
  synthetic + source aeroview-mock, areas recomputed in UTM.
- Tier 2 dynamic (any other bbox): Overpass `highway=*` -> polygonized blocks (bbox frame,
  sliver filter) -> bounded Voronoi split on Input #1 footprint centroids ->
  road setback inset -> `parcels.geojson`. No roads / fetch fail -> flagged
  grid fallback. Output is never empty and never silent.

All parcels carry `"synthetic": true` (Tier 2) — geometric guesses, not
surveyed records. Gate verdicts on them are self-consistency checks.

## Kaggle use

1. Upload this folder as a Utility Script (e.g. `parcel-generator`), attach it.
2. Cell:
   ```
   !pip install -q shapely pyproj requests numpy tqdm
   import sys; sys.path.insert(0, "/kaggle/input/parcel-generator")
   from pipeline import generate_parcel_layer
   out = generate_parcel_layer(
       bbox=[83.3130, 17.7180, 83.3245, 17.7280],
       footprints_geojson="/kaggle/working/Siripuram_Map_Tiles/tiles_amora_footprints.geojson",
       output_dir="/kaggle/working/parcels")
   ```
   (If the mount nests files deeper, point sys.path at the folder that
   actually contains pipeline.py — same lesson as tif_generator.)
3. Gate check (aeroview-ml code):
   ```
   python parcel_gate.py --footprints <footprints.geojson> --parcels /kaggle/working/parcels/parcels.geojson
   ```

## Local use

```
pip install -r requirements.txt
python pipeline.py --bbox 83.313,17.718,83.3245,17.728 --footprints <batch_infer --to-world GeoJSON> --output_dir ./parcels
python pipeline.py --bbox ... --byod register.geojson --output_dir ./parcels   # Tier 1
```

## Rules enforced in code

- Metric ops (buffer, Voronoi, setback) in EPSG:3857; `area_m2` measured in
  local UTM (3857 inflates areas ~10% at lat ~17.7 — never bill from it).
- Footprints must be geographic: village-pixel coords are refused with an
  explicit error (re-run batch_infer with --to-world).
- Narrow blocks survive setback via `is_empty` fallback + `setback_skipped`.
- Overpass responses are disk-cached by bbox hash; re-runs never re-hit API.
