"""osm_fetch.py — OSM Overpass road fetch with disk cache (SIH PS 26011).

Query: all ways with highway=* inside bbox (south,west,north,east).
Cache key: sha1 of rounded bbox + timeout. Re-runs hit disk, never the API.
Polite: single POST, retries with backoff, explicit timeout. Overpass is a
shared public service — callers must cap bbox area before invoking.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
_USER_AGENT = "AERO-VIEW-parcel-generator/1.0 (SIH-26011; research use)"


def bbox_key(bbox: tuple[float, float, float, float]) -> str:
    rounded = ",".join(f"{v:.6f}" for v in bbox)
    return hashlib.sha1(rounded.encode()).hexdigest()[:12]


def build_query(bbox: tuple[float, float, float, float], timeout: int) -> str:
    min_lon, min_lat, max_lon, max_lat = bbox
    return (
        f"[out:json][timeout:{timeout}];"
        f"(way[\"highway\"]({min_lat},{min_lon},{max_lat},{max_lon}););"
        "out geom;"
    )


def fetch_roads(
    bbox: tuple[float, float, float, float],
    cache_dir: str | Path,
    timeout: int = 60,
    retries: int = 3,
) -> dict:
    """Fetch highway=* ways for bbox. Returns parsed Overpass JSON.

    Cache: <cache_dir>/osm_<key>.json. skip on hit. Raises RuntimeError
    after all retries (caller decides fallback — usually grid partition).
    """
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    cfile = cache / f"osm_{bbox_key(bbox)}.json"
    if cfile.exists():
        return json.loads(cfile.read_text())

    query = build_query(bbox, timeout)
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            r = requests.post(
                OVERPASS_URL,
                data={"data": query},
                headers={"User-Agent": _USER_AGENT},
                timeout=timeout + 30,
            )
            r.raise_for_status()
            data = r.json()
            cfile.write_text(json.dumps(data))
            return data
        except (requests.RequestException, ValueError) as e:
            last_err = e
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"Overpass failed after {retries + 1} tries: {last_err}")


def way_coords_lonlat(data: dict) -> list[list[tuple[float, float]]]:
    """Extract per-way [(lon, lat), ...] centerlines. Skips ways with <2 nodes."""
    lines = []
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        pts = [(n["lon"], n["lat"]) for n in el.get("geometry", [])]
        if len(pts) >= 2:
            lines.append(pts)
    return lines
