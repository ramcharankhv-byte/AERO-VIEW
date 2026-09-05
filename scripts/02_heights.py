"""02 - Estimate storeys, height, use type, basements and ground elevation.

Provenance is the product here, not a nicety. Every building carries a
`height_source` recording how its height was arrived at:

    osm_tag       building:levels or height was mapped in OSM  (authoritative)
    surveyed_plan a survey register supplied the storey count  (authoritative)
    dsm_dem       height differenced from a DSM/DEM raster pair
    estimated     inferred from footprint area + building tag  (a guess)

and a `ground_source` recording where its ground elevation came from:

    dsm_dem       sampled from the project's DEM (scripts/dem.py) at the
                  footprint centroid, converted to EGM96 orthometric metres
    placeholder   no DEM, or nodata at that point: the 12.0 m default

Only ~8% of this AOI has a usable OSM height tag, so the estimator drives the
skyline. It is deliberately deterministic -- jitter is seeded from the OSM id
-- so re-running never reshuffles the city, and a building's height is stable
across rebuilds.

IMPORTANT: this script never invents authoritative provenance. `surveyed_plan`
is applied only for ids present in data/surveyed_plans.json, and a ground
elevation is `dsm_dem` only when a real raster was actually read at that point.
If those inputs are absent the buildings stay honestly marked `estimated` and
`placeholder`.

Input:  data/raw_buildings.geojson, data/projects/<slug>/dem.tif (optional)
Output: data/buildings_attributed.geojson, with a top-level "elevation" block
        {elev_source, elev_datum, dem, sampler, sampled, nodata} that
        03_seed_db.py writes onto the project's registry row.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dem as demmod  # noqa: E402
import project as proj  # noqa: E402
from project import DEFAULT_GROUND_ELEV, FLOOR_HEIGHT  # noqa: E402

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

# The DEM and the survey register are per project: a raster of Visakhapatnam
# has nothing to say about a ward in Hyderabad, and a register keyed by OSM id
# would silently mis-attribute if it were shared. The register lives in the
# project's work directory (data/ for the demo project). The DEM lives under
# data/projects/<slug>/ for every project -- see scripts/dem.py, which also
# owns the clip, the sampler and the datum conversion.
def survey_path(p):
    return os.path.join(p.work_dir, "surveyed_plans.json")

# OSM building tag -> our coarse use class
USE_MAP = {
    "apartments": "residential", "residential": "residential", "house": "residential",
    "detached": "residential", "semidetached_house": "residential", "terrace": "residential",
    "bungalow": "residential", "dormitory": "residential", "hut": "residential",
    "commercial": "commercial", "retail": "commercial", "shop": "commercial",
    "office": "commercial", "supermarket": "commercial", "kiosk": "commercial",
    "hotel": "commercial", "restaurant": "commercial",
    "school": "institutional", "college": "institutional", "university": "institutional",
    "hospital": "institutional", "civic": "institutional", "government": "institutional",
    "public": "institutional", "temple": "institutional", "place_of_worship": "institutional",
    "church": "institutional", "mosque": "institutional", "chapel": "institutional",
    "industrial": "industrial", "warehouse": "industrial", "factory": "industrial",
    "service": "industrial", "shed": "industrial", "garage": "industrial",
    "garages": "industrial", "construction": "industrial",
}

# use_type -> ordered (area_ceiling_m2, storeys) bands
BANDS = {
    "residential":   [(60, 1), (120, 2), (260, 3), (600, 5), (1200, 7), (1e9, 9)],
    "commercial":    [(150, 2), (400, 3), (1000, 5), (2500, 8), (1e9, 11)],
    "institutional": [(300, 2), (900, 3), (2500, 4), (1e9, 6)],
    "industrial":    [(400, 1), (1500, 2), (1e9, 3)],
}


def rand01(osm_id, salt=""):
    """Deterministic pseudo-random in [0,1) keyed on the OSM id."""
    h = hashlib.md5(f"{osm_id}:{salt}".encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def classify(tags):
    b = (tags.get("building") or "yes").lower()
    if b in USE_MAP:
        return USE_MAP[b]
    for key in ("amenity", "shop", "office", "tourism"):
        v = (tags.get(key) or "").lower()
        if v in USE_MAP:
            return USE_MAP[v]
        if key == "shop" and v:
            return "commercial"
        if key == "office" and v:
            return "commercial"
    # Indian urban wards are overwhelmingly residential; an untagged
    # 'building=yes' is that, in Siripuram and everywhere else this is pointed.
    return "residential"


def parse_num(v):
    if v is None:
        return None
    try:
        return float(str(v).strip().split()[0].replace("m", ""))
    except (ValueError, IndexError):
        return None


def estimate_storeys(use_type, area, osm_id):
    for ceiling, storeys in BANDS[use_type]:
        if area < ceiling:
            base = storeys
            break
    else:
        base = 2
    # +/-1 storey of deterministic variation so the skyline is not stepped
    r = rand01(osm_id, "storey")
    if r < 0.22:
        base -= 1
    elif r > 0.78:
        base += 1
    return max(1, base)


def basement_count(use_type, floors, osm_id):
    r = rand01(osm_id, "base")
    if use_type == "commercial" and floors >= 3:
        return 2 if r > 0.6 else 1
    if use_type == "residential" and floors >= 6:
        return 1 if r > 0.45 else 0
    if use_type == "institutional" and floors >= 3:
        return 1 if r > 0.7 else 0
    return 0


def load_survey(p):
    """Optional survey register: {osm_id: storeys}. Absent by default.

    Returns (registry, is_synthetic). The synthetic flag is carried all the way
    into the UI so a fabricated demo register is never presented as if it were
    an authoritative survey.
    """
    path = survey_path(p)
    if not os.path.exists(path):
        return {}, False
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    reg = {int(k): int(v) for k, v in (doc.get("storeys") or {}).items()}
    synthetic = bool(doc.get("_synthetic"))
    print(f"  survey register: {len(reg)} buildings "
          f"(source: {doc.get('_source', 'unspecified')}"
          f"{', SYNTHETIC' if synthetic else ''})")
    return reg, synthetic


def centroid(ring):
    xs = [p[0] for p in ring[:-1]] or [p[0] for p in ring]
    ys = [p[1] for p in ring[:-1]] or [p[1] for p in ring]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def main():
    p = proj.parse_args()
    if not os.path.exists(p.raw_buildings_path):
        raise SystemExit(
            f"run scripts/01_fetch_osm.py first (no {p.raw_buildings_path})")
    with open(p.raw_buildings_path, encoding="utf-8") as fh:
        fc = json.load(fh)

    dem = demmod.Sampler(p)
    if not dem:
        print(f"  no DEM at {demmod._rel(p.dem_path)} (or data/dem.tif); "
              f"ground_elev will be the {DEFAULT_GROUND_ELEV} m placeholder")
    survey, survey_synthetic = load_survey(p)
    counts = {"osm_tag": 0, "estimated": 0, "dsm_dem": 0, "surveyed_plan": 0}
    ground_counts = {"dsm_dem": 0, "placeholder": 0}
    out = []

    for feat in fc["features"]:
        props = feat["properties"]
        osm_id = props["osm_id"]
        ring = feat["geometry"]["coordinates"][0]
        # The project's own equirectangular projection, anchored at ITS centre.
        # Using the demo AOI's would have mis-scaled every area outside
        # Visakhapatnam, and area is what drives the storey estimator.
        area = p.ring_area_m2(ring)
        if area < 12:          # sheds/awnings: too small to be a cadastral unit
            continue

        use_type = classify(props)
        levels = parse_num(props.get("building:levels"))
        height = parse_num(props.get("height"))

        synthetic_survey = False
        if osm_id in survey:
            floors, source = int(survey[osm_id]), "surveyed_plan"
            height_m = floors * FLOOR_HEIGHT
            synthetic_survey = survey_synthetic
        elif levels and 1 <= levels <= 100:
            floors, source = int(levels), "osm_tag"
            height_m = height if (height and height > 2) else floors * FLOOR_HEIGHT
        elif height and 2 <= height <= 400:
            floors, source = max(1, round(height / FLOOR_HEIGHT)), "osm_tag"
            height_m = height
        else:
            floors, source = estimate_storeys(use_type, area, osm_id), "estimated"
            height_m = floors * FLOOR_HEIGHT

        lon, lat = centroid(ring)
        ground = dem.sample(lon, lat) if dem else None
        ground_source = "dsm_dem" if ground is not None else "placeholder"
        if ground is None:
            ground = DEFAULT_GROUND_ELEV

        counts[source] += 1
        ground_counts[ground_source] += 1
        props.update({
            "area_m2": round(area, 2),
            "use_type": use_type,
            "floors": floors,
            "height_m": round(float(height_m), 2),
            "height_source": source,
            "survey_synthetic": synthetic_survey,
            "basements": basement_count(use_type, floors, osm_id),
            "ground_elev": round(float(ground), 2),
            "ground_source": ground_source,
            "lon": round(lon, 7),
            "lat": round(lat, 7),
            "name": props.get("name"),
            "address": " ".join(filter(None, [
                props.get("addr:housenumber"), props.get("addr:street"),
            ])) or None,
        })
        out.append(feat)

    fc["features"] = out
    # Project-level elevation provenance. 'cartodem_v3' only when a raster was
    # opened AND at least one building was actually read from it.
    sampled = ground_counts["dsm_dem"]
    fc["elevation"] = {
        "elev_source": demmod.ELEV_SOURCE if (dem and sampled) else "placeholder",
        "elev_datum": dem.datum if (dem and sampled) else None,
        "dem": demmod._rel(dem.path) if dem else None,
        "sampler": dem.kind if dem else None,
        "sampled": sampled,
        "nodata": ground_counts["placeholder"],
    }
    if dem:
        dem.close()
    os.makedirs(p.work_dir, exist_ok=True)
    with open(p.attributed_path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh)

    total = len(out)
    print(f"attributed {total} buildings -> "
          f"{os.path.relpath(p.attributed_path, os.path.join(DATA, '..'))}")
    for k, v in counts.items():
        pct = (100.0 * v / total) if total else 0
        print(f"  height_source={k:<14} {v:>4}  ({pct:.1f}%)")
    if counts["surveyed_plan"] == 0:
        print(f"  note: no survey register at {survey_path(p)}")
    elev = fc["elevation"]
    if dem:
        print(f"  ground_elev: {elev['sampled']} sampled from {elev['dem']} "
              f"via {elev['sampler']} ({elev['elev_datum']}), "
              f"{elev['nodata']} nodata -> {DEFAULT_GROUND_ELEV} m placeholder")
    else:
        print(f"  ground_elev: all {total} at the {DEFAULT_GROUND_ELEV} m placeholder "
              f"(elev_source=placeholder)")


if __name__ == "__main__":
    main()
