"""DEM clip and ground-elevation sampling for the seeding pipeline.

Two jobs, both per project:

  1. clip(p)     data/projects/<slug>/dem_raw.tif  ->  data/projects/<slug>/dem.tif
                 The raw NRSC CartoDEM tile is a 1x1 degree, ~50 MB file; the
                 clip is the project bbox (padded by a few cells) in EPSG:4326,
                 a few kilobytes, and committed. Skipped when dem.tif exists.
                 Done with gdalwarp -- the CLI when it is on PATH or beside the
                 interpreter (a conda env), else GDAL's own Warp() through the
                 Python bindings, which is the same code path.

  2. Sampler(p)  sample(lon, lat) -> orthometric height in metres, or None for
                 nodata / no coverage. rasterio when importable, otherwise a
                 subprocess `gdallocationinfo -valonly -wgs84`. Which one is in
                 use is printed once, so a seed log says how the numbers were
                 read.

VERTICAL DATUM. CartoDEM v3 heights are above the WGS84 ellipsoid, not sea
level. The tile carries no VerticalCSTypeGeoKey and no NRSC sidecar to say so,
but the numbers do: the Siripuram tile reads -5 .. -54 m over dry land, which
is impossible as an orthometric height and exactly what an ellipsoidal one
looks like where the EGM96 geoid sits ~65 m below the ellipsoid. So every
sample is converted to EGM96 orthometric height with pyproj
(EPSG:4979 -> EPSG:4326+5773), and the project records elev_datum
'msl_egm96'. The conversion needs the EGM96 grid; pyproj fetches it from
cdn.proj.org on first use, and if it cannot the stage fails loudly rather than
writing ellipsoidal metres as if they were sea-level ones.

This is the ONE stage of the pipeline with third-party needs. Without any of
them it prints why and returns no sampler, and 02_heights.py keeps the 12.0 m
placeholder with provenance 'placeholder', exactly as it always has.

    python scripts/dem.py [--slug=... --name=... --bbox=...]
"""
import json
import math
import os
import shutil
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import project as proj  # noqa: E402

# 1 arc-second, the CartoDEM v3 posting.
CELL_DEG = 1.0 / 3600.0
# Padding around the bbox so a footprint centroid a few metres past the edge
# still lands on a real cell rather than the clip boundary.
PAD_CELLS = 3

ELEV_SOURCE = "cartodem_v3"
ELEV_DATUM = "msl_egm96"
# What the raw tile's heights are measured against. See the module docstring.
DEM_DATUM = "ellipsoidal"

DEFAULT_NODATA = -32768.0


# ---------------------------------------------------------------- toolchain
def _prefix_dirs():
    """Candidate GDAL install roots: PATH, then the interpreter's own env."""
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    return [
        os.path.join(exe_dir, "Library", "bin"),      # conda on Windows
        os.path.join(exe_dir, "bin"),                  # conda on Linux/macOS
        exe_dir,
        os.path.join(exe_dir, "..", "Library", "bin"),
        os.path.join(exe_dir, "..", "bin"),
    ]


def _configure_gdal_env():
    """Point GDAL and PROJ at their data files when the env is not activated.

    Running <env>/python.exe directly (as `npm run seed:geo` does) skips the
    conda activation that would otherwise export GDAL_DATA and PROJ_DATA;
    without them gdalwarp warns and pyproj cannot find its grids.
    """
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    # The env's DLL directory first: numpy/rasterio/GDAL in a conda env load
    # their BLAS, GDAL and PROJ DLLs from here, and without activation a
    # delay-loaded DLL fails with 0xc06d007f deep inside numpy.
    lib_bin = os.path.join(exe_dir, "Library", "bin")
    if os.path.isdir(lib_bin) and lib_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = lib_bin + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(lib_bin)
    for var, sub in (("GDAL_DATA", "gdal"), ("PROJ_DATA", "proj"), ("PROJ_LIB", "proj")):
        if os.environ.get(var):
            continue
        for base in (os.path.join(exe_dir, "Library", "share"),
                     os.path.join(exe_dir, "share"),
                     os.path.join(exe_dir, "..", "share")):
            cand = os.path.normpath(os.path.join(base, sub))
            if os.path.isdir(cand):
                os.environ[var] = cand
                break


_configure_gdal_env()


def find_tool(name):
    """Full path to a GDAL CLI, or None."""
    exe = shutil.which(name)
    if exe:
        return exe
    for d in _prefix_dirs():
        for cand in (os.path.join(d, name + ".exe"), os.path.join(d, name)):
            if os.path.isfile(cand):
                return os.path.normpath(cand)
    return None


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace")


# ------------------------------------------------------------- raster tags
def read_nodata(path):
    """The raster's nodata value: rasterio, else gdalinfo, else the TIFF tag.

    The last path reads GDAL_NODATA (tag 42113) straight from the file, so the
    value is known even on a machine with no GDAL at all.
    """
    try:
        import rasterio
        with rasterio.open(path) as src:
            if src.nodata is not None:
                return float(src.nodata)
    except ImportError:
        pass
    info = find_tool("gdalinfo")
    if info:
        r = _run([info, "-json", path])
        if r.returncode == 0:
            try:
                bands = json.loads(r.stdout).get("bands") or []
                if bands and bands[0].get("noDataValue") is not None:
                    return float(bands[0]["noDataValue"])
            except (ValueError, KeyError):
                pass
    try:
        with open(path, "rb") as f:
            head = f.read(8)
            little = head[:2] == b"II"
            fmt = "<" if little else ">"
            if head[2:4] not in (b"\x2a\x00", b"\x00\x2a"):
                return DEFAULT_NODATA          # BigTIFF or not a TIFF; fall back
            (off,) = struct.unpack(fmt + "I", head[4:8])
            f.seek(off)
            (n,) = struct.unpack(fmt + "H", f.read(2))
            for _ in range(n):
                tag, typ, cnt = struct.unpack(fmt + "HHI", f.read(8))
                raw = f.read(4)
                if tag == 42113:
                    if cnt <= 4:
                        data = raw[:cnt]
                    else:
                        (o,) = struct.unpack(fmt + "I", raw)
                        f.seek(o)
                        data = f.read(cnt)
                    return float(data.split(b"\x00")[0].decode("ascii", "replace"))
    except (OSError, ValueError, struct.error):
        pass
    return DEFAULT_NODATA


# ------------------------------------------------------------------- clip
def clip_bounds(p):
    pad = PAD_CELLS * CELL_DEG
    return (p.west - pad, p.south - pad, p.east + pad, p.north + pad)


def clip(p):
    """Write p.dem_path from p.dem_raw_path. Returns the engine used, or None."""
    if os.path.exists(p.dem_path):
        print(f"  dem.tif present, skipping clip: {_rel(p.dem_path)}")
        return "existing"
    raw = p.dem_raw_path
    if not raw:
        print(f"  no raw DEM for {p.slug} (expected {_rel(os.path.join(p.dem_dir, 'dem_raw.tif'))})")
        return None

    nodata = read_nodata(raw)
    w, s, e, n = clip_bounds(p)
    print(f"  clipping {_rel(raw)} -> {_rel(p.dem_path)}  "
          f"bbox={w:.6f},{s:.6f},{e:.6f},{n:.6f}  nodata={nodata:g}")
    os.makedirs(p.dem_dir, exist_ok=True)

    # gdalwarp options. -tap snaps the extent to the resolution grid so the
    # clip's cells coincide with the source's and near-neighbour copies values
    # rather than resampling them.
    warp_args = [
        "-overwrite", "-of", "GTiff",
        "-t_srs", "EPSG:4326",
        "-te", f"{w:.9f}", f"{s:.9f}", f"{e:.9f}", f"{n:.9f}", "-te_srs", "EPSG:4326",
        "-tr", f"{CELL_DEG:.12f}", f"{CELL_DEG:.12f}", "-tap",
        "-r", "near",
        "-dstnodata", f"{nodata:g}",
        "-co", "COMPRESS=DEFLATE",
    ]

    exe = find_tool("gdalwarp")
    if exe:
        r = _run([exe] + warp_args + [raw, p.dem_path])
        if r.returncode != 0:
            raise SystemExit(f"dem: gdalwarp failed:\n{r.stderr.strip()}")
        print(f"  engine: gdalwarp CLI ({exe})")
        return "gdalwarp"

    try:
        from osgeo import gdal
    except ImportError:
        raise SystemExit(
            "dem: no gdalwarp on PATH and the GDAL Python bindings are not "
            "importable. Install the seed toolchain (README: 'Ground elevation') "
            "or clip the tile elsewhere and place it at " + _rel(p.dem_path))
    gdal.UseExceptions()
    gdal.Warp(p.dem_path, raw, options=gdal.WarpOptions(options=warp_args))
    print("  engine: osgeo.gdal.Warp (gdalwarp library entry point)")
    return "gdal-python"


# ---------------------------------------------------------------- sampling
class Sampler:
    """sample(lon, lat) -> orthometric metres, or None. Falsy when no raster."""

    def __init__(self, p):
        self.path = None
        self.kind = None
        self.nodata = None
        self._src = None
        self._tool = None
        self._to_msl = None
        for cand in (p.dem_path, p.global_dem_path):
            if os.path.exists(cand):
                self.path = cand
                break
        if not self.path:
            return

        try:
            import rasterio
            self._src = rasterio.open(self.path)
            self.kind = "rasterio"
            self.nodata = self._src.nodata
            self._bounds = tuple(self._src.bounds)     # left, bottom, right, top
            print(f"  DEM opened: {_rel(self.path)} ({self._src.width}x{self._src.height}) "
                  f"via rasterio, nodata={self.nodata}")
        except ImportError:
            self._tool = find_tool("gdallocationinfo")
            if not self._tool:
                print(f"  {_rel(self.path)} present but neither rasterio nor "
                      f"gdallocationinfo is available - ground_elev stays placeholder")
                self.path = None
                return
            self.kind = "gdallocationinfo"
            self.nodata = read_nodata(self.path)
            self._bounds = None
            print(f"  DEM: {_rel(self.path)} via gdallocationinfo ({self._tool}), "
                  f"nodata={self.nodata}")

        if DEM_DATUM == "ellipsoidal":
            self._to_msl = _egm96_transformer()
            self.datum = ELEV_DATUM
            print("  datum: ellipsoidal (WGS84) -> orthometric via EGM96 (pyproj)")
        else:
            self.datum = "msl"

    def __bool__(self):
        return self.path is not None

    def _is_nodata(self, v):
        if v is None:
            return True
        if isinstance(v, float) and math.isnan(v):
            return True
        if self.nodata is not None and abs(float(v) - float(self.nodata)) < 1e-6:
            return True
        # Belt and braces: CartoDEM voids are -32768; nothing on Earth is < -1000.
        return float(v) <= -1000.0

    def _raw(self, lon, lat):
        if self.kind == "rasterio":
            l, b, r, t = self._bounds
            if not (l <= lon <= r and b <= lat <= t):
                return None
            try:
                v = next(self._src.sample([(lon, lat)]))[0]
            except (StopIteration, IndexError, ValueError):
                return None
            return None if self._is_nodata(v) else float(v)

        r = _run([self._tool, "-valonly", "-wgs84", self.path, f"{lon:.8f}", f"{lat:.8f}"])
        out = r.stdout.strip()
        if r.returncode != 0 or not out:
            return None
        try:
            v = float(out.splitlines()[0])
        except ValueError:
            return None
        return None if self._is_nodata(v) else v

    def sample(self, lon, lat):
        h = self._raw(lon, lat)
        if h is None:
            return None
        if self._to_msl is not None:
            _, _, H = self._to_msl.transform(lon, lat, h)
            if not math.isfinite(H):
                raise SystemExit(
                    "dem: EGM96 conversion returned a non-finite height; the "
                    "geoid grid is not available. Run `pyproj sync --file "
                    "us_nga_egm96_15` (needs network) or set PROJ_NETWORK=ON.")
            return float(H)
        return float(h)

    def close(self):
        if self._src is not None:
            self._src.close()


def _egm96_transformer():
    try:
        import pyproj
    except ImportError:
        raise SystemExit(
            "dem: the raster is ellipsoidal and pyproj is not importable, so its "
            "heights cannot be converted to sea level. Install the seed toolchain "
            "(README: 'Ground elevation').")
    try:
        from pyproj import network
        network.set_network_enabled(True)   # fetch the EGM96 grid from cdn.proj.org
    except Exception:  # noqa: BLE001 - older pyproj without the module
        pass
    # EPSG:4979 = WGS84 3D (ellipsoidal h); EPSG:5773 = EGM96 height.
    return pyproj.Transformer.from_crs("EPSG:4979", "EPSG:4326+5773", always_xy=True)


def _rel(path):
    try:
        return os.path.relpath(path, proj.ROOT).replace(os.sep, "/")
    except ValueError:
        return path


def main():
    p = proj.parse_args()
    print(f"DEM for {p.describe()}")
    engine = clip(p)
    if engine is None:
        print("  ground_elev will stay at the placeholder for this project")
        return
    # A quick read-back so a bad clip is caught here, not three stages later.
    s = Sampler(p)
    if s:
        h = s.sample(p.lon0, p.lat0)
        print(f"  centre ({p.lon0:.5f}, {p.lat0:.5f}) -> "
              f"{'nodata' if h is None else f'{h:.2f} m {s.datum}'}")
        s.close()


if __name__ == "__main__":
    main()
