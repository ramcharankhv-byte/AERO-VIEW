"""lidar_engine.py — universal point-cloud height engine (SIH 26011 / lidar-input).

Multi-format ingestion (.pcd .ply .xyz .las .laz) -> per-footprint LiDAR
height candidates for consensus.py, plus direct LADM-style 3D GeoJSON export.

Design: the heavy cloud loads ONCE per path (module cache). Footprint bboxes
prefilter points with numpy slicing before the exact vectorized
point-in-polygon test, so 3M+ point clouds stay interactive. open3d is used
when present; pure-numpy/laspy fallbacks keep headless Kaggle working.

Kaggle use:
    from lidar_engine import extract_lidar_heights, generate_lidar_elevation_geojson
    got = extract_lidar_heights("vmrda_georeferenced_epsg32644.pcd", footprints_gdf)
    cands = [c for c in got.values() if c]  # None = < 20 points, skip in fusion
"""

from __future__ import annotations

from pathlib import Path

LIDAR_CRS = "EPSG:32644"
MIN_POINTS = 20
LIDAR_SIGMA = 0.1  # direct geometric measurement: tightest of all sources
FLOOR_HEIGHT_M = 3.0
BASEMENT_DEPTH_M = 3.0
VERTICAL_DATUM = "EGM2008"

SUPPORTED = {".pcd", ".ply", ".xyz", ".las", ".laz"}

# path -> (points (N,3) float64, classes (N,) int32 | None)
_CACHE: dict[str, tuple] = {}


# ---------------------------------------------------------------- loaders ---
def _read_pcd_numpy(path: str) -> tuple:
    """Binary PCD v0.7 x/y/z (float32) -> (points, None). No classification."""
    import numpy as np

    raw = Path(path).read_bytes()
    marker = b"DATA binary\n"
    i = raw.find(marker)
    if i < 0:
        raise ValueError(f"only binary PCD v0.7 supported without open3d: {path}")
    n = int([l for l in raw[:i].decode().splitlines()
             if l.startswith("POINTS")][0].split()[-1])
    buf = raw[i + len(marker): i + len(marker) + n * 12]
    if len(buf) != n * 12:
        raise ValueError(f"truncated point data in {path}")
    pts = np.frombuffer(buf, dtype=np.float32).reshape(-1, 3).astype(np.float64)
    return pts, None


_PLY_TYPES = {"char": "i1", "uchar": "u1", "short": "i2", "ushort": "u2",
              "int": "i4", "uint": "u4", "float": "f4", "double": "f8"}


def _read_ply_numpy(path: str) -> tuple:
    """PLY with x/y/z vertex properties (ascii or binary_little_endian)."""
    import numpy as np

    raw = Path(path).read_bytes()
    m = raw.find(b"end_header")
    if m < 0:
        raise ValueError(f"bad PLY header: {path}")
    nl = raw.find(b"\n", m)  # tolerant of \n and \r\n line endings
    header = raw[:m].decode("ascii", errors="replace").splitlines()
    fmt = "ascii" if any(l.startswith("format ascii") for l in header) else "binary"
    n = 0
    props: list[tuple[str, str]] = []  # (name, numpy dtype) in file order
    in_vertex = False
    for line in header:
        t = line.split()
        if t[:2] == ["element", "vertex"]:
            n, in_vertex = int(t[2]), True
        elif t[:2] == ["element", "face"]:
            in_vertex = False
        elif t[0] == "property" and in_vertex and len(t) == 3:
            props.append((t[2], _PLY_TYPES[t[1]]))
    names = [p[0] for p in props]
    ix, iy, iz = names.index("x"), names.index("y"), names.index("z")
    body = raw[nl + 1:]
    if fmt == "ascii":
        import io

        arr = np.loadtxt(io.StringIO(body.decode("ascii", errors="replace")),
                         dtype=np.float64, ndmin=2)
        return np.column_stack([arr[:, ix], arr[:, iy], arr[:, iz]]), None
    dt = np.dtype([(f"c{i}", d) for i, (_, d) in enumerate(props)])
    rec = np.frombuffer(body[: n * dt.itemsize], dtype=dt)
    cols = [rec[f"c{i}"].astype(np.float64) for i in (ix, iy, iz)]
    return np.column_stack(cols), None


def _read_xyz_numpy(path: str) -> tuple:
    """Whitespace x y z [extra cols ignored] -> (points, None)."""
    import numpy as np

    arr = np.loadtxt(path, dtype=np.float64, ndmin=2)
    if arr.shape[1] < 3:
        raise ValueError(f"need >= 3 columns in {path}")
    return arr[:, :3].copy(), None


def _read_las(path: str) -> tuple:
    """LAS/LAZ via laspy. Returns (points, classification|None).

    ASPRS classes drive Z attribution downstream: 2 = ground, 6 = building.
    Unclassified (all zeros / absent) -> pure geometry fallback.
    """
    import numpy as np

    import laspy

    las = laspy.read(path)
    pts = np.column_stack([np.asarray(las.x, dtype=np.float64),
                           np.asarray(las.y, dtype=np.float64),
                           np.asarray(las.z, dtype=np.float64)])
    try:
        cls = np.asarray(las.classification, dtype=np.int32)
        if cls.size == len(pts) and np.any(cls != 0):
            return pts, cls
    except Exception:
        pass
    return pts, None


def _load_with_classes(path: str | Path) -> tuple:
    """Cached (points, classes|None). open3d fast-path, format fallbacks."""
    key = str(path)
    if key in _CACHE:
        return _CACHE[key]
    ext = Path(key).suffix.lower()
    if ext not in SUPPORTED:
        raise ValueError(f"unsupported cloud format '{ext}': {key} (want {sorted(SUPPORTED)})")
    pts, cls = None, None
    if ext in (".pcd", ".ply", ".xyz"):  # try open3d uniformly first
        try:
            import numpy as np

            import open3d as o3d

            pc = o3d.io.read_point_cloud(key)
            if len(pc.points):
                pts = np.asarray(pc.points, dtype=np.float64)
        except Exception:
            pts = None
    if pts is None:
        if ext == ".pcd":
            pts, cls = _read_pcd_numpy(key)
        elif ext == ".ply":
            pts, cls = _read_ply_numpy(key)
        elif ext == ".xyz":
            pts, cls = _read_xyz_numpy(key)
        else:  # .las / .laz
            pts, cls = _read_las(key)
    _CACHE[key] = (pts, cls)
    return pts, cls


def load_point_cloud(file_path: str | Path):
    """Public loader: any supported format -> unified (N, 3) float64 [x, y, z]."""
    pts, _ = _load_with_classes(file_path)
    return pts


# ------------------------------------------------------------------ masks ---
def _inside_mask(xs, ys, polygon):
    """Vectorized point-in-polygon. shapely 2.x contains(), mpl fallback."""
    try:
        import shapely

        return shapely.contains(polygon, shapely.points(xs, ys))
    except Exception:
        pass
    from matplotlib.path import Path as MplPath

    import numpy as np

    return MplPath(np.asarray(polygon.exterior.coords)).contains_points(
        np.column_stack([xs, ys]))


def _footprint_id(row, idx: int) -> str:
    if hasattr(row, "get"):
        for col in ("building_id", "id", "ulpin", "parcel_id"):
            try:
                v = row.get(col)
            except Exception:
                v = None
            if v is not None and str(v).strip():
                return str(v)
    return f"B-{idx + 1:05d}"


def _prep_footprints(footprints_gdf, target_crs: str):
    gdf = footprints_gdf
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    if str(gdf.crs).upper() != str(target_crs).upper():
        gdf = gdf.to_crs(target_crs)
    return gdf


def _building_stats(zin, min_points: int):
    """Clip p1/p99 noise, then Z_ground=p5, Z_roof=p95, H=max(roof-ground, 3).

    Returns (z_ground, z_roof, height) or None when < min_points survive.
    """
    import numpy as np

    zin = np.asarray(zin, dtype=np.float64)
    zin = zin[np.isfinite(zin)]
    if len(zin) < min_points:
        return None
    lo, hi = np.percentile(zin, [1, 99])  # kill -25 m / +99 m anomalies
    zin = zin[(zin >= lo) & (zin <= hi)]
    if len(zin) < min_points:
        return None
    zg, zr = float(np.percentile(zin, 5)), float(np.percentile(zin, 95))
    return zg, zr, max(round(zr - zg, 2), FLOOR_HEIGHT_M)


# ------------------------------------------------------------------ API ----
def extract_lidar_heights(
    cloud_path: str | Path,
    footprints_gdf,
    target_crs: str = LIDAR_CRS,
    min_points: int = MIN_POINTS,
) -> dict:
    """Crop cloud per footprint -> consensus-ready height candidates.

    Class-aware: inside points tagged ASPRS 2 ground Z_ground, class 6
    roof Z_roof; missing/unclassified classes fall back to pure geometry.

    Returns {building_id: {"name": "lidar_point_cloud", "value": H,
    "sigma": 0.1}}; buildings with too few points map to None (skip them
    before fuse_heights).
    """
    import numpy as np

    pts, cls = _load_with_classes(cloud_path)
    xs, ys, zs = pts[:, 0], pts[:, 1], pts[:, 2]
    gdf = _prep_footprints(footprints_gdf, target_crs)

    out: dict = {}
    for idx in range(len(gdf)):
        row = gdf.iloc[idx]
        bid = _footprint_id(row, idx)
        geom = row.geometry
        if geom is None or geom.is_empty:
            out[bid] = None
            continue
        # bbox prefilter (numpy slicing) before exact polygon test
        minx, miny, maxx, maxy = geom.bounds
        cidx = np.nonzero((xs >= minx) & (xs <= maxx) & (ys >= miny) & (ys <= maxy))[0]
        if len(cidx) < min_points:
            out[bid] = None
            continue
        inside = np.asarray(_inside_mask(xs[cidx], ys[cidx], geom), dtype=bool)
        cidx = cidx[inside]
        if len(cidx) < min_points:
            out[bid] = None
            continue
        if cls is not None:  # ASPRS-aware split, geometry fallback per role
            tags = cls[cidx]
            gz = zs[cidx][tags == 2]
            rz = zs[cidx][tags == 6]
            g = _building_stats(gz if len(gz) >= min_points else zs[cidx], min_points)
            r = _building_stats(rz if len(rz) >= min_points else zs[cidx], min_points)
            if g is None or r is None:
                out[bid] = None
                continue
            zg, _, _ = g
            _, zr, _ = r
            height = max(round(zr - zg, 2), FLOOR_HEIGHT_M)
            out[bid] = {"name": "lidar_point_cloud", "value": height, "sigma": LIDAR_SIGMA}
        else:
            st = _building_stats(zs[cidx], min_points)
            if st is None:
                out[bid] = None
                continue
            zg, zr, height = st
            out[bid] = {"name": "lidar_point_cloud", "value": height, "sigma": LIDAR_SIGMA}
    return out


def generate_lidar_elevation_geojson(
    cloud_path: str | Path,
    footprints_gdf,
    output_path: str | Path,
    target_crs: str = LIDAR_CRS,
    min_points: int = MIN_POINTS,
    floor_height: float = FLOOR_HEIGHT_M,
    basement: float = BASEMENT_DEPTH_M,
):
    """Footprints + LiDAR -> validated 3D GeoJSON (no GDAL/pyogrio I/O).

    Attaches Z_base (ground p5), H_final, Z_roof, Z_sub (-basement),
    floors, floor_slices, sources='lidar_point_cloud'. Returns the
    GeoDataFrame in target_crs; the file is re-validated by reload.
    """
    import json

    import geopandas as gpd
    import numpy as np

    pts, cls = _load_with_classes(cloud_path)
    xs, ys, zs = pts[:, 0], pts[:, 1], pts[:, 2]
    gdf = _prep_footprints(footprints_gdf, target_crs)

    records: list[dict] = []
    for idx in range(len(gdf)):
        row = gdf.iloc[idx]
        bid = _footprint_id(row, idx)
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        minx, miny, maxx, maxy = geom.bounds
        cidx = np.nonzero((xs >= minx) & (xs <= maxx) & (ys >= miny) & (ys <= maxy))[0]
        if len(cidx) < min_points:
            continue
        inside = np.asarray(_inside_mask(xs[cidx], ys[cidx], geom), dtype=bool)
        zin = zs[cidx][inside]
        st = _building_stats(zin, min_points)
        if st is None:
            continue
        zg, zr, height = st
        floors = max(1, int(round(height / floor_height)))
        records.append({
            "building_id": bid,
            "geometry": geom,
            "Z_base": round(zg, 3),
            "Z_ground": round(zg, 3),
            "H_final": round(height, 2),
            "height": round(height, 2),
            "Z_roof": round(zr, 3),
            "Z_sub": round(zg - basement, 3),
            "floors": floors,
            "floor_slices": [[round(zg + i * floor_height, 3),
                              round(zg + (i + 1) * floor_height, 3)]
                             for i in range(floors)],
            "sources": "lidar_point_cloud",
            "vertical_datum": VERTICAL_DATUM,
            "crs": target_crs,
        })

    cols = ["building_id", "Z_base", "Z_ground", "H_final", "height", "Z_roof",
            "Z_sub", "floors", "floor_slices", "sources", "vertical_datum", "crs"]
    out_gdf = (gpd.GeoDataFrame(records, geometry="geometry", crs=target_crs)
               if records else
               gpd.GeoDataFrame({c: [] for c in cols}, geometry=[], crs=target_crs))
    dest = Path(output_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(out_gdf.to_json())  # plain write: no pyogrio/GDAL crashes
    # reload validation: parseable FeatureCollection, geometry + props intact
    fc = json.loads(dest.read_text())
    assert fc.get("type") == "FeatureCollection" and isinstance(fc.get("features"), list)
    assert len(fc["features"]) == len(out_gdf)
    print(f"[done] {len(out_gdf)} lidar-elevated buildings -> {dest.name}")
    return out_gdf


__all__ = ["extract_lidar_heights", "generate_lidar_elevation_geojson",
           "load_point_cloud", "LIDAR_CRS", "MIN_POINTS", "LIDAR_SIGMA",
           "FLOOR_HEIGHT_M", "BASEMENT_DEPTH_M", "VERTICAL_DATUM", "SUPPORTED"]
