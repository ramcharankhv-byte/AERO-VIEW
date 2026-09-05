"""05 - Export the seeded cadastre to static JSON under data/api/<slug>/.

These files are what the route handlers serve when PostGIS is unreachable, so
`npm run dev` alone renders the full app. PostGIS remains the source of truth --
this is a committed snapshot of it, not a parallel implementation.

Everything here is scoped to ONE project, read from the seed_ctx row that
scripts/project.py publishes. A second AOI writes a second directory and
touches nothing in the first.

Two things are written besides the five cadastre files:

  * `projects.stats` on the project's own row, so the gallery can print entity
    counts without running seven COUNT(*) queries per card;
  * `data/api/projects.json`, the committed registry snapshot, which is what
    makes the gallery render -- and the demo project open -- with the database
    down. It is rebuilt from every row in `projects`, not just this one, so
    exporting one project never drops another from the registry.

Geometry note: floors and units are exported as their 2D ring plus z_min/z_max
rather than as POLYHEDRALSURFACE WKT. Cesium extrudes a polygon between two
heights natively, so the ring+extent form is both what the renderer actually
wants and about an order of magnitude smaller on the wire.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg  # noqa: E402
import project as proj  # noqa: E402

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

# Every query below filters on this. floor and unit have no project_id of their
# own -- they inherit one through building -- so they are scoped by the join
# they already had rather than by a duplicated column.
SCOPE = "(SELECT project_id FROM seed_ctx)"

BUILDINGS = f"""
SELECT json_build_object(
  'type','FeatureCollection',
  'aoi', (SELECT name FROM projects WHERE id = {SCOPE}),
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', b.id,
    'geometry', ST_AsGeoJSON(b.footprint, 7)::json,
    'properties', json_build_object(
      'id', b.id, 'ulpin', b.ulpin, 'parcel_id', b.parcel_id,
      'height_m', b.height_m, 'floors', b.floors, 'basements', b.basements,
      'ground_elev', b.ground_elev, 'ground_source', b.ground_source, 'use_type', b.use_type,
      'flood_risk', b.flood_risk, 'cyclone_risk', b.cyclone_risk,
      'flood_score', b.flood_score, 'cyclone_score', b.cyclone_score,
      'coast_dist_m', b.coast_dist_m, 'local_relief_m', b.local_relief_m,
      'height_source', b.height_source, 'survey_synthetic', b.survey_synthetic, 'name', b.name, 'address', b.address,
      'osm_id', b.osm_id))), '[]'::json))
FROM building b WHERE b.project_id = {SCOPE};
"""

PARCELS = f"""
SELECT json_build_object(
  'type','FeatureCollection',
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', p.id,
    'geometry', ST_AsGeoJSON(p.geom, 7)::json,
    'properties', json_build_object(
      'id', p.id, 'ulpin', p.ulpin, 'area_m2', p.area_m2, 'owner', p.owner))), '[]'::json))
FROM parcel p WHERE p.project_id = {SCOPE};
"""

UTILITIES = f"""
SELECT json_build_object(
  'type','FeatureCollection',
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', u.id,
    'geometry', ST_AsGeoJSON(u.geom_3d, 7)::json,
    'properties', json_build_object(
      'id', u.id, 'asset_type', u.asset_type, 'depth_m', u.depth_m,
      'radius_m', u.radius_m, 'authority', u.authority, 'status', u.status,
      'in_conflict', EXISTS (SELECT 1 FROM conflict c
                              WHERE c.a_type='utility' AND c.a_id = u.id)))), '[]'::json))
FROM utility u WHERE u.project_id = {SCOPE};
"""

CONFLICTS = f"""
SELECT COALESCE(json_agg(json_build_object(
  'id', c.id, 'kind', c.kind, 'detected_at', c.detected_at,
  'utility_id', u.id, 'asset_type', u.asset_type, 'authority', u.authority,
  'status', u.status, 'depth_m', u.depth_m,
  'floor_id', f.id, 'floor_ulpin', f.ulpin, 'level_no', f.level_no,
  'building_id', b.id, 'building_ulpin', b.ulpin, 'building_name', b.name)
  ORDER BY c.id), '[]'::json)
FROM conflict c
JOIN utility u  ON u.id = c.a_id
JOIN floor f    ON f.id = c.b_id
JOIN building b ON b.id = f.building_id
WHERE b.project_id = {SCOPE};
"""

DETAIL = f"""
SELECT COALESCE(json_object_agg(s.id, s.doc), '{{}}'::json) FROM (
  SELECT b.id, json_build_object(
    'building', json_build_object(
      'id', b.id, 'ulpin', b.ulpin, 'parcel_id', b.parcel_id,
      'height_m', b.height_m, 'floors', b.floors, 'basements', b.basements,
      'ground_elev', b.ground_elev, 'ground_source', b.ground_source, 'use_type', b.use_type,
      'flood_risk', b.flood_risk, 'cyclone_risk', b.cyclone_risk,
      'flood_score', b.flood_score, 'cyclone_score', b.cyclone_score,
      'coast_dist_m', b.coast_dist_m, 'local_relief_m', b.local_relief_m,
      'height_source', b.height_source, 'survey_synthetic', b.survey_synthetic, 'name', b.name, 'address', b.address,
      'osm_id', b.osm_id,
      'footprint', ST_AsGeoJSON(b.footprint, 7)::json),
    'parcel', (SELECT json_build_object(
        'id', p.id, 'ulpin', p.ulpin, 'area_m2', p.area_m2, 'owner', p.owner,
        'geometry', ST_AsGeoJSON(p.geom, 7)::json)
      FROM parcel p WHERE p.id = b.parcel_id),
    'floors', COALESCE((SELECT json_agg(json_build_object(
        'id', f.id, 'ulpin', f.ulpin, 'level_no', f.level_no,
        'z_min', f.z_min, 'z_max', f.z_max, 'detect_source', f.detect_source,
        'ring', ST_AsGeoJSON(ST_Force2D(b.footprint), 7)::json)
        ORDER BY f.level_no)
      FROM floor f WHERE f.building_id = b.id), '[]'::json),
    'units', COALESCE((SELECT json_agg(json_build_object(
        'id', un.id, 'floor_id', un.floor_id, 'ulpin', un.ulpin,
        'unit_no', un.unit_no, 'z_min', un.z_min, 'z_max', un.z_max,
        'carpet_m2', un.carpet_m2, 'built_m2', un.built_m2,
        'tenure', un.tenure, 'encumbrance', un.encumbrance,
        'level_no', f2.level_no,
        'ring', ST_AsGeoJSON(ST_Force2D(ST_GeometryN(un.geom_3d, 1)), 7)::json)
        ORDER BY f2.level_no, un.unit_no)
      FROM unit un JOIN floor f2 ON f2.id = un.floor_id
      WHERE f2.building_id = b.id), '[]'::json)
  ) AS doc
  FROM building b WHERE b.project_id = {SCOPE}
) s;
"""

# Rebuilt from every row, so exporting one project never drops another from
# the registry the gallery reads with the database down.
REGISTRY = """
SELECT json_build_object('projects', COALESCE(json_agg(json_build_object(
  'slug', p.slug,
  'name', p.name,
  'bbox', json_build_array(ST_XMin(p.bbox_geom), ST_YMin(p.bbox_geom),
                           ST_XMax(p.bbox_geom), ST_YMax(p.bbox_geom)),
  'state_code', p.state_code,
  'district_code', p.district_code,
  'scheme_code', p.scheme_code,
  'status', p.status,
  'elev_source', p.elev_source,
  'elev_datum', p.elev_datum,
  'bhuvan_layers', p.bhuvan_layers,
  'created_at', to_char(p.created_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'stats', CASE WHEN p.stats = '{}'::jsonb THEN NULL ELSE p.stats END)
  ORDER BY p.created_at, p.id), '[]'::json))
FROM projects p;
"""

STATS = f"""
SELECT json_build_object(
  'buildings', (SELECT count(*) FROM building WHERE project_id = {SCOPE}),
  'parcels',   (SELECT count(*) FROM parcel   WHERE project_id = {SCOPE}),
  'floors',    (SELECT count(*) FROM floor f JOIN building b ON b.id = f.building_id
                 WHERE b.project_id = {SCOPE}),
  'units',     (SELECT count(*) FROM unit u JOIN floor f ON f.id = u.floor_id
                 JOIN building b ON b.id = f.building_id
                 WHERE b.project_id = {SCOPE}),
  'utilities', (SELECT count(*) FROM utility WHERE project_id = {SCOPE}),
  'conflicts', (SELECT count(*) FROM conflict c JOIN utility u ON u.id = c.a_id
                 WHERE u.project_id = {SCOPE}));
"""


def dump(out_dir, name, sql):
    os.makedirs(out_dir, exist_ok=True)
    raw = pg.scalar(sql)
    if not raw:
        raise SystemExit(f"export {name}: query returned nothing")
    obj = json.loads(raw)
    path = os.path.join(out_dir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    size = os.path.getsize(path) / 1024.0
    n = len(obj["features"]) if isinstance(obj, dict) and "features" in obj else len(obj)
    print(f"  {name:<18} {n:>6} entries  {size:>8.0f} KB")
    return obj


def street_count(out_dir):
    """Streets are a build artefact, not a table -- see lib/db.ts getRoads().

    Counted from the file rather than queried, and reported as 0 when
    scripts/build_roads.mjs has not run for this project yet.
    """
    path = os.path.join(out_dir, "roads.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return len(json.load(fh).get("features", []))
    except (OSError, ValueError):
        return 0


def main():
    p = proj.parse_args()
    proj.make_seed_ctx(p)
    out = p.api_dir
    print(f"exporting static snapshots -> data/api/{p.slug}/")

    dump(out, "buildings.json", BUILDINGS)
    dump(out, "parcels.json", PARCELS)
    dump(out, "utilities.json", UTILITIES)
    dump(out, "conflicts.json", CONFLICTS)
    dump(out, "detail.json", DETAIL)

    stats = json.loads(pg.scalar(STATS))
    stats["streets"] = street_count(out)
    proj.write_stats(p, stats)
    # Only now: a project is 'ready' when there is something to read, not when
    # the pipeline started.
    proj.set_status(p, "ready")

    registry_path = os.path.join(DATA, "api", "projects.json")
    registry = json.loads(pg.scalar(REGISTRY))
    with open(registry_path, "w", encoding="utf-8") as fh:
        json.dump(registry, fh, indent=2)
        fh.write("\n")
    print(f"  {'projects.json':<18} {len(registry['projects']):>6} project(s)")
    print("  stats: " + ", ".join(f"{k}={v}" for k, v in sorted(stats.items())))
    print("done")


if __name__ == "__main__":
    main()
