"""05 - Export the seeded cadastre to static JSON under data/api/.

These files are what the route handlers serve when PostGIS is unreachable, so
`npm run dev` alone renders the full app. PostGIS remains the source of truth --
this is a committed snapshot of it, not a parallel implementation.

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

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "api")

BUILDINGS = """
SELECT json_build_object(
  'type','FeatureCollection',
  'aoi', 'Siripuram, Visakhapatnam',
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', b.id,
    'geometry', ST_AsGeoJSON(b.footprint, 7)::json,
    'properties', json_build_object(
      'id', b.id, 'ulpin', b.ulpin, 'parcel_id', b.parcel_id,
      'height_m', b.height_m, 'floors', b.floors, 'basements', b.basements,
      'ground_elev', b.ground_elev, 'use_type', b.use_type,
      'height_source', b.height_source, 'survey_synthetic', b.survey_synthetic, 'name', b.name, 'address', b.address,
      'osm_id', b.osm_id))), '[]'::json))
FROM building b;
"""

PARCELS = """
SELECT json_build_object(
  'type','FeatureCollection',
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', p.id,
    'geometry', ST_AsGeoJSON(p.geom, 7)::json,
    'properties', json_build_object(
      'id', p.id, 'ulpin', p.ulpin, 'area_m2', p.area_m2, 'owner', p.owner))), '[]'::json))
FROM parcel p;
"""

UTILITIES = """
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
FROM utility u;
"""

CONFLICTS = """
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
JOIN building b ON b.id = f.building_id;
"""

DETAIL = """
SELECT COALESCE(json_object_agg(s.id, s.doc), '{}'::json) FROM (
  SELECT b.id, json_build_object(
    'building', json_build_object(
      'id', b.id, 'ulpin', b.ulpin, 'parcel_id', b.parcel_id,
      'height_m', b.height_m, 'floors', b.floors, 'basements', b.basements,
      'ground_elev', b.ground_elev, 'use_type', b.use_type,
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
  FROM building b
) s;
"""


def dump(name, sql):
    os.makedirs(OUT, exist_ok=True)
    raw = pg.scalar(sql)
    if not raw:
        raise SystemExit(f"export {name}: query returned nothing")
    obj = json.loads(raw)
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    size = os.path.getsize(path) / 1024.0
    n = len(obj["features"]) if isinstance(obj, dict) and "features" in obj else len(obj)
    print(f"  {name:<18} {n:>6} entries  {size:>8.0f} KB")


def main():
    print("exporting static snapshots -> data/api/")
    dump("buildings.json", BUILDINGS)
    dump("parcels.json", PARCELS)
    dump("utilities.json", UTILITIES)
    dump("conflicts.json", CONFLICTS)
    dump("detail.json", DETAIL)
    print("done")


if __name__ == "__main__":
    main()
