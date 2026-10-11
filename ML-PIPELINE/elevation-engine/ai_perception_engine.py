"""ai_perception_engine.py — AI Perception Tier (SIH 26011).

YOLOv8-seg drone-tile segmentation and PointNet++ point-cloud classification
for raw unparsed survey data. Both stages run on CPU-only notebooks with no
manual setup: pretrained weights download automatically when online, and each
stage carries a deterministic vision path that produces the same output
contract. Every output records which path produced it in `source`.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("ai_perception")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[%(name)s] %(levelname)s: %(message)s"))
    log.addHandler(_h)
log.setLevel(logging.INFO)


# ------------------------------------------------- 1. YOLO footprints ------
class YOLO2DFootprintExtractor:
    """YOLOv8-seg drone-tile -> building footprint polygons (EPSG:3857 default)."""

    def __init__(self, weights: str = "yolov8n-seg.pt", conf: float = 0.35,
                 device: str = "cpu"):
        self.weights = weights
        self.conf = conf
        self.device = device

    def extract_footprints_from_drone_tile(self, ortho_tif_path: str | Path):
        """Run segmentation (or contour fallback). Returns GeoDataFrame.

        Columns: geometry, confidence, source, area_m2. CRS from the tile's
        embedded transform when readable, else pixel CRS (flagged in source).
        """
        import geopandas as gpd
        from shapely.geometry import shape as _shape

        img, transform, crs = self._read_tile(str(ortho_tif_path))
        try:
            feats = self._yolo_masks(img)
            src = f"yolov8-seg:{Path(self.weights).name}"
        except Exception as e:
            log.warning("neural inference unavailable (%s) — vision path", e)
            try:
                feats = self._contour_fallback(img)
            except Exception as e2:
                log.warning("vision path unavailable (%s) — empty result", e2)
                feats = []
            src = "contour-fallback"
        geoms, confs = [], []
        for poly_px, conf in feats:
            try:
                g = self._px_to_world(poly_px, transform)
                if g is not None and g.is_valid and g.area > 0:
                    geoms.append(g)
                    confs.append(float(conf))
            except Exception:
                continue
        out = gpd.GeoDataFrame({"confidence": confs, "source": [src] * len(geoms)},
                               geometry=geoms, crs=crs or "EPSG:3857")
        try:
            out["area_m2"] = out.geometry.area
        except Exception:
            out["area_m2"] = 0.0
        log.info("%s: %d footprints from %s", src, len(out), Path(ortho_tif_path).name)
        return out

    def _read_tile(self, path: str):
        """RGB array + affine + crs. rasterio first, PIL pixel fallback."""
        try:
            import numpy as np
            import rasterio

            with rasterio.open(path) as src:
                img = np.moveaxis(src.read([1, 2, 3]), 0, -1)
                return img, src.transform, (str(src.crs) if src.crs else None)
        except Exception as e:
            log.warning("rasterio unreadable (%s) — PIL pixel mode", e)
            from PIL import Image

            import numpy as np

            return np.asarray(Image.open(path).convert("RGB")), None, None

    def _yolo_masks(self, img):
        """Ultralytics YOLOv8-seg -> [([x, y] px polygon, conf)]. Raises if unusable."""
        from ultralytics import YOLO

        import numpy as np

        model = YOLO(self.weights)  # downloads on first use; raises offline
        res = model.predict(img, conf=self.conf, device=self.device, verbose=False)[0]
        if res.masks is None or res.boxes is None:
            return []
        feats = []
        for seg, conf in zip(res.masks.xy, res.boxes.conf):
            seg = np.asarray(seg, dtype=float)
            if len(seg) >= 4:
                feats.append((seg, float(conf)))
        if not feats:
            raise RuntimeError("YOLO found no instances — falling back")
        return feats

    def _contour_fallback(self, img):
        """Bright-compact blob polygonization. Returns [([x, y], 0.5)]."""
        import cv2
        import numpy as np

        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        blur = cv2.GaussianBlur(gray, (5, 5), 0)
        _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        th = cv2.morphologyEx(th, cv2.MORPH_CLOSE,
                              np.ones((7, 7), np.uint8), iterations=2)
        contours, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        feats = []
        for c in contours:
            if cv2.contourArea(c) < 200:  # speckle reject (tile-px units)
                continue
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.01 * peri, True).reshape(-1, 2).astype(float)
            if len(approx) >= 4:
                feats.append((approx, 0.5))
        return feats

    @staticmethod
    def _px_to_world(poly_px, transform):
        """Pixel polygon -> world via affine; None-transform = pixel coords."""
        from shapely.geometry import Polygon

        import numpy as np

        px = np.asarray(poly_px, dtype=float)
        if transform is not None:
            a, b, c, d, e, f = (transform.a, transform.b, transform.c,
                                transform.d, transform.e, transform.f)
            wx, wy = a * px[:, 0] + b * px[:, 1] + c, d * px[:, 0] + e * px[:, 1] + f
            return Polygon(np.column_stack([wx, wy]))
        return Polygon(px)


# ------------------------------------------------- 2. PointNet classes -----
class PointNet3DSemanticClassifier:
    """PointNet++ per-point labels {2: ground, 5: vegetation, 6: building}."""

    # ASPRS vy4589 standard codes reused so lidar_engine consumes them directly.
    GROUND, VEGETATION, BUILDING = 2, 5, 6

    def __init__(self, weights: str | None = None, device: str = "cpu",
                 cell_m: float = 2.0, window_m: float = 30.0):
        self.weights = weights
        self.device = device
        self.cell_m = cell_m
        self.window_m = window_m  # roofs narrower than this are removed from ground

    def classify_point_cloud_classes(self, pcd_path: str | Path) -> dict:
        """Classify cloud -> {"labels", "counts", "source", "n"}.

        labels: (N,) int32 array aligned with load order. Network path needs
        torch + weights file; otherwise the geometric fallback runs (and says so).
        """
        import numpy as np

        pts = self._load_xyz(str(pcd_path))
        try:
            labels = self._pointnet_forward(pts)
            src = f"pointnet++:{Path(self.weights).name if self.weights else 'default'}"
        except Exception as e:
            log.warning("checkpoint inference unavailable (%s) — geometric path", e)
            labels = self._geometric_fallback(pts)
            src = "geometric-fallback"
        uniq, counts = np.unique(labels, return_counts=True)
        log.info("%s: %d pts -> %s", src, len(pts),
                 {int(k): int(v) for k, v in zip(uniq, counts)})
        return {"labels": labels.astype(np.int32),
                "counts": {int(k): int(v) for k, v in zip(uniq, counts)},
                "source": src, "n": int(len(pts))}

    @staticmethod
    def _load_xyz(path: str):
        import numpy as np

        ext = Path(path).suffix.lower()
        if ext in (".xyz", ".txt"):
            return np.loadtxt(path, dtype=np.float64, ndmin=2)[:, :3].copy()
        try:  # reuse the lidar engine's multi-format loader when on path
            from lidar_engine import load_point_cloud

            return np.asarray(load_point_cloud(path), dtype=np.float64)
        except Exception:
            pass
        try:
            import open3d as o3d

            return np.asarray(o3d.io.read_point_cloud(path).points, dtype=np.float64)
        except Exception as e:
            raise RuntimeError(f"cannot load {path}: {e}")

    def _pointnet_forward(self, pts):
        """Real network path: torch + weights required, else raises."""
        import numpy as np  # noqa: F401 (kept for parity with fallback branch)

        import torch

        if not self.weights or not Path(str(self.weights)).exists():
            raise RuntimeError("no PointNet++ weights file configured/found")
        ckpt = torch.load(self.weights, map_location=self.device)
        model = ckpt["model"] if isinstance(ckpt, dict) and "model" in ckpt else ckpt
        model.eval()
        with torch.no_grad():
            out = model(torch.from_numpy(pts[:, :3].astype("float32").T[None]).to(self.device))
        return out.argmax(1).cpu().numpy().astype(np.int32)

    def _geometric_fallback(self, pts):
        """Morphological ground classification with planarity split.

        Ground surface = opening of the 2 m cell-minimum grid with a wide
        maximum window (default 30 m): any roof narrower than the window is
        erased from the surface, so big flat roofs can't self-ground.
        ground (2): z within 0.5 m of the surface. building (6): > 2 m above
        ground AND locally flat (high-point neighbourhood Z-std < 0.4 m).
        vegetation (5): high but rough.
        """
        import numpy as np

        x, y, z = pts[:, 0], pts[:, 1], pts[:, 2]
        c = self.cell_m
        gx = np.floor((x - x.min()) / c).astype(np.int64)
        gy = np.floor((y - y.min()) / c).astype(np.int64)
        nx, ny = int(gx.max()) + 1, int(gy.max()) + 1
        mins = np.full((nx, ny), np.inf)
        np.minimum.at(mins, (gx, gy), z)  # fine cell minima
        fill = float(np.percentile(z, 2))
        mins[~np.isfinite(mins)] = np.nan
        M = np.where(np.isnan(mins), fill, mins)
        W = max(3, int(round(self.window_m / c)) | 1)  # odd window
        P = np.pad(M, W // 2, mode="edge")

        def _maxfilt(A):
            v = np.lib.stride_tricks.sliding_window_view(A, (W, W))
            return v.max(axis=(-2, -1))

        eroded = _maxfilt(-P) * -1.0  # minimum filter = erode bright roofs
        opened = _maxfilt(np.pad(eroded, W // 2, mode="edge"))  # dilate back
        surf = opened[gx, gy]  # opened ground surface
        hag = z - surf
        # neighbourhood roughness from HIGH points only: a roof cell also
        # contains ground hits, and their bimodal spread would fake roughness.
        high1 = hag > 1.0
        std = np.zeros(len(pts))
        key = gx * (int(gy.max()) + 1) + gy
        hidx = np.nonzero(high1)[0]
        if len(hidx):
            hk = key[hidx]
            ho = np.argsort(hk)
            uk = np.unique(hk[ho])
            b2 = np.searchsorted(hk[ho], uk, side="left")
            b2 = np.append(b2, len(ho))
            for a, b in zip(b2[:-1], b2[1:]):
                seg = hidx[ho[a:b]]
                std[seg] = z[seg].std() if b - a > 3 else 0.0
        labels = np.full(len(pts), self.GROUND, dtype=np.int32)
        high = hag > 2.0
        labels[high & (std < 0.4)] = self.BUILDING
        labels[high & (std >= 0.4)] = self.VEGETATION
        return labels


__all__ = ["YOLO2DFootprintExtractor", "PointNet3DSemanticClassifier", "log"]
