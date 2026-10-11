# Data notes

Large point clouds (`*.pcd`, ~92MB: `tb_*`, `vmrda_*_epsg32644.pcd`) are NOT committed.
Source: Kaggle dataset `yellapusomeshwar/lidar-input` + notebook `yellapusomeshwar/aeroview-ml`.

Small committed sample: `parcel-generator/siripuram_parcels.geojson` (mocked demo, flagged synthetic in code).
CRS: WGS84 `EPSG:4326` (exchange), Web-Mercator `EPSG:3857` (tiles), UTM `EPSG:32644` (Vizag metric).
