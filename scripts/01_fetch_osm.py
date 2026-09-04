"""01 - Fetch OSM building footprints and road centrelines for one project.

Uses `out geom;` so Overpass inlines coordinates and we never have to resolve
node references ourselves. Stdlib only (urllib), so there is no dependency on
wheels that may not yet exist for the local Python.

Outputs, per project:
    <work>/raw_buildings.geojson    normalised footprints
    <work>/raw_highways.geojson     normalised centrelines
    <work>/osm.json                 the RAW Overpass responses, as returned

`<work>` is `data/` for the demo project -- where its extract has always been
committed -- and `data/projects/<slug>/` for every other. See scripts/project.py.

The raw cache is kept for two reasons. A re-run never has to ask Overpass
again, which is the whole of the etiquette question for a service that is free
and shared. And a question about what the pipeline was actually given has an
answer that is not a transformed derivative of it.

Re-running is a no-op unless --force is passed; the committed snapshot is the
source of truth so the build is reproducible without network access.

OVERPASS ETIQUETTE. This sends a real, identifying User-Agent, tries each
mirror at most twice with a widening backoff, and fails loudly with a readable
message rather than writing a partial or empty extract. An empty result is
treated as a mirror failure, not as an answer: a regional instance returns
200/empty for an AOI it does not cover, and seeding a cadastre from that would
produce an empty project that looks like a successful run.
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
import project as proj  # noqa: E402

# Mirrors are tried in order. The main overpass-api.de instance rate-limits
# hard and starts refusing connections outright after a handful of queries from
# one IP, so it is not first.
#
# NOTE: only *global* mirrors belong here. Regional instances (e.g.
# overpass.osm.ch, which carries Switzerland only) answer 200 with zero
# elements for an AOI they do not cover, which is why overpass() below treats
# an empty result as a mirror failure rather than a valid answer.
ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# A real, identifying User-Agent. Overpass asks for one, and a request that
# says what it is can be rate-limited or contacted rather than simply dropped.
USER_AGENT = (
    "ulpin-3d/1.0 (3D ULPIN vertical property mapper; "
    "https://github.com/ramcharankhv-byte/aero-view; seeding pipeline)"
)

# One retry per mirror, with a widening wait. Eight attempts at five-second
# intervals is not politeness, it is a small denial of service.
ROUNDS = 2
TIMEOUT_S = 240


def buildings_query(p):
    return f"""[out:json][timeout:180];
(
  way["building"]({p.overpass_bbox});
  relation["building"]({p.overpass_bbox});
);
out geom;"""


def highways_query(p):
    return f"""[out:json][timeout:180];
(
  way["highway"]({p.overpass_bbox});
);
out geom;"""


def _via_curl(url, query):
    """Overpass rejects urllib's default header set on some mirrors with a bare
    406, so curl -- which is present on every platform we target -- is the
    primary transport and urllib is the fallback."""
    proc = subprocess.run(
        ["curl", "-sS", "--fail", "-m", str(TIMEOUT_S), "-X", "POST", url,
         "-A", USER_AGENT,
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
        headers={"Accept": "*/*", "User-Agent": USER_AGENT,
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode())


def overpass(query, label):
    """POST to Overpass, trying both transports and all mirrors, backing off.

    Raises SystemExit with a readable message rather than returning a partial
    or empty payload. A half-seeded project is worse than no project: it looks
    like data.
    """
    last = None
    have_curl = shutil.which("curl") is not None
    attempts = ROUNDS * len(ENDPOINTS)
    for attempt in range(attempts):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        host = urllib.parse.urlparse(url).netloc
        for transport in (["curl"] if have_curl else []) + ["urllib"]:
            try:
                print(f"  [{label}] attempt {attempt + 1}/{attempts} "
                      f"-> {host} via {transport}")
                fn = _via_curl if transport == "curl" else _via_urllib
                payload = fn(url, query)
                if "elements" not in payload:
                    raise RuntimeError("response had no 'elements'")
                # A regional extract answers 200/empty for an AOI it does not
                # cover. Empty means wrong mirror, not "nothing there".
                if not payload["elements"]:
                    raise RuntimeError("mirror returned 0 elements (regional extract?)")
                return payload
            except Exception as exc:  # noqa: BLE001 - any transport failure retries
                last = exc
                print(f"  [{label}] {type(exc).__name__}: {str(exc)[:160]}")
        if attempt < attempts - 1:
            wait = 5 * (attempt + 1)
            print(f"  [{label}] retrying in {wait}s")
            time.sleep(wait)

    raise SystemExit(
        f"\nseed: Overpass could not answer for {label} after {attempts} "
        f"attempts across {len(ENDPOINTS)} mirrors.\n"
        f"  last error: {type(last).__name__}: {str(last)[:300]}\n"
        f"\n"
        f"  Nothing has been written. This is deliberate -- a partial or empty\n"
        f"  extract would seed a cadastre that looks real and is not.\n"
        f"\n"
        f"  If you are offline, the demo project's extract is committed and\n"
        f"  `npm run seed` with no arguments needs no network at all. For a new\n"
        f"  AOI, try again later; Overpass is a free shared service and its\n"
        f"  mirrors rate-limit."
    )


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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)
    n = len(obj["features"])
    print(f"  wrote {os.path.basename(path)}: {n} features "
          f"({os.path.getsize(path) / 1024:.0f} KB)")
    return n


def main():
    p = proj.parse_args()
    force = "--force" in sys.argv

    if (os.path.exists(p.raw_buildings_path)
            and os.path.exists(p.raw_highways_path) and not force):
        print(f"raw OSM snapshots already present for {p.slug}; "
              f"pass --force to refetch")
        return

    print(f"Fetching OSM for {p.describe()}")
    p.ensure_dirs()

    buildings_raw = overpass(buildings_query(p), "buildings")
    highways_raw = overpass(highways_query(p), "highways")

    # The raw responses, before any normalisation. Written only once BOTH
    # queries have succeeded, so the cache never records half an AOI.
    with open(p.osm_cache_path, "w", encoding="utf-8") as fh:
        json.dump({
            "_source": "https://wiki.openstreetmap.org/wiki/Overpass_API",
            "_licence": "ODbL — © OpenStreetMap contributors",
            "_fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "project": p.slug,
            "bbox": list(p.bbox),
            "buildings": buildings_raw,
            "highways": highways_raw,
        }, fh)
    print(f"  cached raw Overpass response -> "
          f"{os.path.basename(p.osm_cache_path)} "
          f"({os.path.getsize(p.osm_cache_path) / 1024:.0f} KB)")

    nb = write(p.raw_buildings_path, buildings_to_geojson(buildings_raw))
    nh = write(p.raw_highways_path, highways_to_geojson(highways_raw))
    if nb == 0:
        raise SystemExit(
            f"seed: Overpass answered but no building footprint survived "
            f"normalisation for {p.slug}. Check the bbox: {p.bbox}")
    print(f"done: {nb} buildings, {nh} road ways")


if __name__ == "__main__":
    main()
