"""consensus.py — robust height fusion and LADM quality engine (SIH 26011).

Pure-python + numpy. No rasterio/duckdb needed, so it runs anywhere
including bare Kaggle cells for unit tests.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

try:
    import numpy as np
except ImportError:  # minimal fallback if numpy missing
    np = None  # type: ignore[assignment]


def _is_finite(x: Any) -> bool:
    try:
        f = float(x)
    except Exception:
        return False
    return math.isfinite(f)


def fuse_heights(candidates: List[Dict[str, Any]], min_h: float = 2.0, max_h: float = 120.0) -> Dict[str, Any]:
    """Fuse height candidates into one robust estimate.

    Candidate schema: {"source": str, "value": float, "sigma": float}.
    Expected inputs: Overture height (sigma 2.0), num_floors*3.0 (sigma 3.0),
    regional typology prior (sigma 4.5).

    Steps: filter valid -> median + MAD -> robust_sigma ->
    3-sigma reject -> Huber-reweighted inverse-variance fusion ->
    height, sigma (uncertainty), confidence, sources, floors.

    Maths (per spec):
      robust_sigma = max(1.4826 * MAD, 0.75)
      keep iff abs(value - median) <= 3.0 * robust_sigma
      residual = values - median
      cutoff = 1.5 * robust_sigma
      huber = cutoff / abs(residual) where exceeded else 1.0
      weights = huber / sigma^2
      height = sum(w * v) / sum(w)
      uncertainty = sqrt(1 / sum(w))
      confidence = (n_used / n_total) * exp(-std(values) / max(height, 1))
      floors = max(1, round(height / 3))
    """
    vals: List[float] = []
    sigs: List[float] = []
    srcs: List[str] = []
    for c in candidates or []:
        try:
            v = float(c.get("value"))
            s = float(c.get("sigma", 3.0))
            src = str(c.get("source", "unknown"))
        except Exception:
            continue
        if not _is_finite(v) or not _is_finite(s):
            continue
        if v <= 0 or s <= 0:
            continue
        if v < min_h or v > max_h:
            continue
        vals.append(v)
        sigs.append(s)
        srcs.append(src)

    if not vals:
        return {"height": 6.0, "sigma": 4.5, "confidence": 0.15, "sources": ["fallback-prior"], "floors": 2}

    n_total = len(vals)
    if np is not None:
        arr = np.array(vals, dtype=float)
        med = float(np.median(arr))
        mad = float(np.median(np.abs(arr - med)))
    else:
        srt = sorted(vals)
        med = float(srt[len(srt) // 2])
        mad = float(sorted([abs(v - med) for v in vals])[len(vals) // 2])

    robust_sigma = max(1.4826 * mad, 0.75)

    kept_v: List[float] = []
    kept_s: List[float] = []
    kept_src: List[str] = []
    for v, s, src in zip(vals, sigs, srcs):
        if abs(v - med) <= 3.0 * robust_sigma:
            kept_v.append(v)
            kept_s.append(s)
            kept_src.append(src)

    if not kept_v:  # all rejected -> median with low confidence
        h = float(med)
        return {
            "height": round(h, 2),
            "sigma": round(float(robust_sigma), 2),
            "confidence": 0.25,
            "sources": ["median-fallback"],
            "floors": max(1, int(round(h / 3.0))),
        }

    if np is not None:
        kv = np.array(kept_v, dtype=float)
        ks = np.array(kept_s, dtype=float)
        residual = kv - med
        cutoff = 1.5 * robust_sigma
        huber = np.where(np.abs(residual) > cutoff, cutoff / np.maximum(np.abs(residual), 1e-9), 1.0)
        weights = huber / np.maximum(ks ** 2, 1e-9)
        wsum = float(np.sum(weights))
        height = float(np.sum(weights * kv) / wsum) if wsum > 0 else float(med)
        uncertainty = float(math.sqrt(1.0 / wsum)) if wsum > 0 else float(robust_sigma)
        std = float(np.std(kv)) if len(kv) > 1 else 0.0
    else:
        cutoff = 1.5 * robust_sigma
        weights_list: List[float] = []
        for v, s in zip(kept_v, kept_s):
            r = abs(v - med)
            huber_w = 1.0 if r <= cutoff else cutoff / max(r, 1e-9)
            weights_list.append(huber_w / max(s * s, 1e-9))
        wsum = sum(weights_list)
        height = sum(w * v for w, v in zip(weights_list, kept_v)) / wsum if wsum > 0 else float(med)
        uncertainty = math.sqrt(1.0 / wsum) if wsum > 0 else float(robust_sigma)
        std = (max(kept_v) - min(kept_v)) / 2.0 if len(kept_v) > 1 else 0.0

    confidence = (len(kept_v) / max(n_total, 1)) * math.exp(-std / max(height, 1.0))
    confidence = round(max(0.05, min(1.0, confidence)), 3)
    floors = max(1, int(round(height / 3.0)))
    return {
        "height": round(float(height), 2),
        "sigma": round(float(uncertainty), 2),
        "confidence": confidence,
        "sources": kept_src,
        "floors": floors,
    }


def typology_prior(area_m2: float = 120.0, urban: bool = True) -> Dict[str, Any]:
    """Regional fallback prior when Overture has no height."""
    if area_m2 < 60:
        h = 3.5
    elif area_m2 < 150:
        h = 6.0
    elif area_m2 < 400:
        h = 9.0
    else:
        h = 12.0 if urban else 6.0
    return {"source": "typology-prior", "value": float(h), "sigma": 4.5}
