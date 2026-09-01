"""01 - Fetch OSM building footprints and road centrelines for the AOI.

Uses `out geom;` so Overpass inlines coordinates and we never have to resolve
node references ourselves. Stdlib only (urllib), so there is no dependency on
wheels that may not yet exist for the local Python.

Outputs (committed):
    data/raw_buildings.geojson
    data/raw_highways.geojson

Re-running is a no-op unless --force is passed; the committed snapshot is the
source of truth so the build is reproducible without network access.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aoi import OVERPASS_BBOX, BBOX, AOI_NAME  # noqa: E402

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
# Mirrors are tried in order. The main overpass-api.de instance rate-limits
# hard and starts refusing connections outright after a handful of queries from
# one IP, so it is not first.
#
# NOTE: only *global* mirrors belong here. Regional instances (e.g.
# overpass.osm.ch, which carries Switzerland only) answer 200 with zero
# elements for this AOI, which is why overpass() below treats an empty result
# as a mirror failure rather than a valid answer.
ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

BUILDINGS_Q = f"""[out:json][timeout:180];
(
  way["building"]({OVERPASS_BBOX});
  relation["building"]({OVERPASS_BBOX});
);
out geom;"""

HIGHWAYS_Q = f"""[out:json][timeout:180];
(
  way["highway"]({OVERPASS_BBOX});
);
out geom;"""


def _via_curl(url, query):
    """Overpass rejects urllib's default header set on some mirrors with a bare
    406, so curl -- which is present on every platform we target -- is the
    primary transport and urllib is the fallback."""
    proc = subprocess.run(
        ["curl", "-sS", "--fail", "-m", "240", "-X", "POST", url,
         "--data-urlencode", f"data={query}"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl exit {proc.returncode}: {proc.stderr.strip()[:200]}")
    return json.loads(proc.stdout)


def _via_urllib(url, query):
    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"Accept": "*/*", "User-Agent": "curl/8.0",
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        return json.loads(resp.read().decode())


def overpass(query, label):
    """POST to Overpass, trying both transports and all mirrors, backing off."""
    last = None
    have_curl = shutil.which("curl") is not None
    for attempt in range(6):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        host = urllib.parse.urlparse(url).netloc
        for transport in (["curl"] if have_curl else []) + ["urllib"]:
            try:
                print(f"  [{label}] attempt {attempt + 1} -> {host} via {transport}")
                fn = _via_curl if transport == "curl" else _via_urllib
                payload = fn(url, query)
                if "elements" not in payload:
                    raise RuntimeError("response had no 'elements'")
                # A regional extract answers 200/empty for an AOI it does not
                # cover. The AOI is known to be populated, so empty == wrong
                # mirror, not "nothing there".
                if not payload["elements"]:
                    raise RuntimeError("mirror returned 0 elements (regional extract?)")
                return payload
            except Exception as exc:  # noqa: BLE001 - any transport failure retries
                last = exc
                print(f"  [{label}] {type(exc).__name__}: {str(exc)[:120]}")
        wait = 5 * (attempt + 1)
        print(f"  [{label}] retrying in {wait}s")
        time.sleep(wait)
    raise SystemExit(f"Overpass failed for {label}: {last}")


def ring_from_geometry(geom):
    """Overpass 'geometry' array -> closed GeoJSON linear ring."""
    ring = [[p["lon"], p["lat"]] for p in geom if p is not None]
    if len(ring) < 3:
        return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring if len(ring) >= 4 else None


def buildings_to_geojson(payload):
    feats = []
    for el in payload.get("elements", []):
        tags = el.get("tags", {}) or {}
        ring = None
        if el["type"] == "way":
            ring = ring_from_geometry(el.get("geometry", []) or [])
        elif el["type"] == "relation":
            # multipolygon building: take the largest closed outer member
            best = None
            for m in el.get("members", []) or []:
                if m.get("role") != "outer":
                    continue
                r = ring_from_geometry(m.get("geometry", []) or [])
                if r and (best is None or len(r) > len(best)):
                    best = r
            ring = best
        if not ring:
            continue
        feats.append({
            "type": "Feature",
            "id": f"{el['type']}/{el['id']}",
            "properties": {"osm_id": el["id"], "osm_type": el["type"], **tags},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })
    return {"type": "FeatureCollection", "features": feats}


def highways_to_geojson(payload):
    feats = []
    for el in payload.get("elements", []):
        if el["type"] != "way":
            continue
        line = [[p["lon"], p["lat"]] for p in el.get("geometry", []) or []]
        if len(line) < 2:
            continue
        tags = el.get("tags", {}) or {}
        feats.append({
            "type": "Feature",
            "id": f"way/{el['id']}",
            "properties": {"osm_id": el["id"], **tags},
            "geometry": {"type": "LineString", "coordinates": line},
        })
    return {"type": "FeatureCollection", "features": feats}


def write(path, obj):
    os.makedirs(DATA, exist_ok=True)
    full = os.path.join(DATA, path)
    with open(full, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)
    n = len(obj["features"])
    print(f"  wrote {path}: {n} features ({os.path.getsize(full) / 1024:.0f} KB)")
    return n


def main():
    force = "--force" in sys.argv
    b_path = os.path.join(DATA, "raw_buildings.geojson")
    h_path = os.path.join(DATA, "raw_highways.geojson")
    if os.path.exists(b_path) and os.path.exists(h_path) and not force:
        print("raw OSM snapshots already present; pass --force to refetch")
        return

    print(f"Fetching OSM for {AOI_NAME}  bbox={BBOX}")
    nb = write("raw_buildings.geojson", buildings_to_geojson(overpass(BUILDINGS_Q, "buildings")))
    nh = write("raw_highways.geojson", highways_to_geojson(overpass(HIGHWAYS_Q, "highways")))
    print(f"done: {nb} buildings, {nh} road ways")


if __name__ == "__main__":
    main()
