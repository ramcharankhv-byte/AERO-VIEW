"""overture.py — Overture Maps 3D building streaming via DuckDB (SIH 26011 Input 3).

Streams public Overture building GeoParquet from the AWS Open Data mirror
(s3://overturemaps-us-west-2, us-west-2) with unsigned access — no key, no
login. Uses DuckDB httpfs + spatial with server-side pushdown so headless
Kaggle never downloads full releases.

Release resolution: the bucket only retains recent releases (old pins age
out — e.g. 2024-08-20.0 is gone). The latest release is resolved at call
time via an anonymous S3 listing, with a known-good fallback:
  s3://overturemaps-us-west-2/release/<latest>/theme=buildings/type=building/*

Kaggle use (flat utility script — both import styles work):
    from overture import get_overture_buildings
    gdf = get_overture_buildings([83.3130, 17.7180, 83.3245, 17.7280])
"""

from __future__ import annotations

OVERTURE_BUCKET_URL = "https://overturemaps-us-west-2.s3.amazonaws.com"
OVERTURE_FALLBACK_RELEASE = "2026-08-19.0"
OVERTURE_S3_PATH = (
    f"s3://overturemaps-us-west-2/release/{OVERTURE_FALLBACK_RELEASE}/theme=buildings/type=building/*"
)
OVERTURE_REGION = "us-west-2"

_CACHED_RELEASE: str | None = None


def _resolve_release(timeout: int = 20) -> str:
    """Latest Overture release id (e.g. '2026-08-19.0'), cached per process.

    Anonymous S3 ListObjects on prefix release/ — no key. Falls back to
    OVERTURE_FALLBACK_RELEASE when the listing fails (offline / blocked).
    """
    global _CACHED_RELEASE
    if _CACHED_RELEASE is not None:
        return _CACHED_RELEASE
    try:
        import re

        import requests

        r = requests.get(
            OVERTURE_BUCKET_URL,
            params={"list-type": "2", "prefix": "release/", "delimiter": "/", "max-keys": "50"},
            timeout=timeout,
        )
        r.raise_for_status()
        found = re.findall(r"<Prefix>release/(\d{4}-\d{2}-\d{2}\.\d+)/</Prefix>", r.text)
        if found:
            _CACHED_RELEASE = sorted(found)[-1]
            return _CACHED_RELEASE
    except Exception as e:
        print(f"[warn] overture release listing failed ({e}) — using fallback {OVERTURE_FALLBACK_RELEASE}")
    _CACHED_RELEASE = OVERTURE_FALLBACK_RELEASE
    return _CACHED_RELEASE


def _overture_s3_path() -> str:
    return (
        f"s3://overturemaps-us-west-2/release/{_resolve_release()}/theme=buildings/type=building/*"
    )


def _list_building_parts(release: str, timeout: int = 60) -> list[str]:
    """Explicit part-file URLs via anonymous HTTPS listing (no DuckDB S3 LIST).

    DuckDB's glob needs an S3 LIST that some networks/hosts reject with
    'Unknown error for HTTP GET'. Plain-HTTPS ListObjectsV2 works everywhere
    the bucket is public, and read_parquet() accepts the explicit URL list —
    direct GETs only, no LIST involved.
    """
    import xml.etree.ElementTree as ET

    import requests

    prefix = f"release/{release}/theme=buildings/type=building/"
    keys: list[str] = []
    token: str | None = None
    ns = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
    while True:
        params: dict[str, str] = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        r = requests.get(OVERTURE_BUCKET_URL, params=params, timeout=timeout)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        for e in root.findall("s:Contents/s:Key", ns):
            if e.text and e.text.endswith(".parquet"):
                keys.append(f"s3://overturemaps-us-west-2/{e.text}")
        truncated = (root.findtext("s:IsTruncated", default="false", namespaces=ns) or "false").lower()
        token = root.findtext("s:NextContinuationToken", default=None, namespaces=ns)
        if truncated != "true" or not token:
            break
    return keys


def _overture_sources() -> str:
    """SQL file list for read_parquet: explicit URLs, glob fallback."""
    try:
        parts = _list_building_parts(_resolve_release())
    except Exception as e:
        print(f"[warn] part listing failed ({e}) — falling back to glob")
        parts = []
    if parts:
        return "[" + ",".join(f"'{u}'" for u in parts) + "]"
    return f"'{_overture_s3_path()}'"

_EXPECTED_COLS = ["id", "height", "num_floors", "min_height", "roof_height", "geometry"]


def _connect_unsigned():
    """In-memory DuckDB connection with unsigned S3 + spatial enabled."""
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
    except Exception:
        # older DuckDB bundles spatial under a different capsule — retry load only
        con.execute("LOAD spatial;")
    con.execute(f"SET s3_region='{OVERTURE_REGION}';")
    # AWS deprecated path-style URLs — vhost is the DuckDB default for S3.
    con.execute("SET s3_url_style='vhost';")
    con.execute("SET s3_use_ssl=true;")
    # unsigned public bucket: prefer the anonymous flag, fall back to empty keys
    try:
        con.execute("SET s3_anonymous=true;")
    except Exception:
        con.execute("SET s3_access_key_id='';")
        con.execute("SET s3_secret_access_key='';")
        try:
            con.execute("SET s3_session_token='';")
        except Exception:
            pass
    return con


def _empty_buildings_gdf():
    """Empty GeoDataFrame with the contract schema (EPSG:4326)."""
    import geopandas as gpd
    from shapely.geometry import Polygon

    gdf = gpd.GeoDataFrame(
        {
            "id": [],
            "height": [],
            "num_floors": [],
            "min_height": [],
            "roof_height": [],
        },
        geometry=[Polygon()],
        crs="EPSG:4326",
    )
    return gdf.iloc[0:0].copy()


def get_overture_buildings(bbox: list[float] | tuple[float, float, float, float]):
    """Fetch Overture buildings intersecting bbox via pushdown SQL.

    Args:
        bbox: [min_lon, min_lat, max_lon, max_lat] in EPSG:4326.

    Returns:
        GeoDataFrame (EPSG:4326) with columns id, height, num_floors,
        min_height, roof_height, geometry. Empty GDF with matching schema
        when the query returns 0 rows or the fetch fails.
    """
    import geopandas as gpd
    from shapely import wkb

    min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox)
    if not (min_lon < max_lon and min_lat < max_lat):
        raise ValueError(f"bad bbox: {list(bbox)}")

    sources = _overture_sources()

    full_sql = f"""
        SELECT
            id,
            height,
            num_floors,
            min_height,
            roof_height,
            ST_AsWKB(geometry) AS geometry_wkb
        FROM read_parquet({sources})
        WHERE bbox.xmin <= {max_lon}
          AND bbox.xmax >= {min_lon}
          AND bbox.ymin <= {max_lat}
          AND bbox.ymax >= {min_lat}
          AND ST_Intersects(
                geometry,
                ST_MakeEnvelope({min_lon}, {min_lat}, {max_lon}, {max_lat}))
    """
    # Older/newer releases may lack min_height / roof_height — minimal fallback.
    minimal_sql = f"""
        SELECT
            id,
            height,
            num_floors,
            ST_AsWKB(geometry) AS geometry_wkb
        FROM read_parquet({sources})
        WHERE bbox.xmin <= {max_lon}
          AND bbox.xmax >= {min_lon}
          AND bbox.ymin <= {max_lat}
          AND bbox.ymax >= {min_lat}
          AND ST_Intersects(
                geometry,
                ST_MakeEnvelope({min_lon}, {min_lat}, {max_lon}, {max_lat}))
    """

    con = None
    try:
        con = _connect_unsigned()
        try:
            rel = con.execute(full_sql)
            rows = rel.fetchall()
            cols = [d[0] for d in rel.description]
            full = True
        except Exception:
            rel = con.execute(minimal_sql)
            rows = rel.fetchall()
            cols = [d[0] for d in rel.description]
            full = False
        if not rows:
            return _empty_buildings_gdf()
        idx = {c: i for i, c in enumerate(cols)}
        records: list[dict] = []
        geoms = []
        for r in rows:
            try:
                g = wkb.loads(bytes(r[idx["geometry_wkb"]]))
            except Exception:
                continue
            if g is None or g.is_empty:
                continue
            rec = {
                "id": str(r[idx["id"]]) if r[idx["id"]] is not None else None,
                "height": _to_float(r[idx.get("height", -1)]),
                "num_floors": _to_float(r[idx.get("num_floors", -1)]),
                "min_height": _to_float(r[idx["min_height"]]) if full and "min_height" in idx else None,
                "roof_height": _to_float(r[idx["roof_height"]]) if full and "roof_height" in idx else None,
            }
            records.append(rec)
            geoms.append(g)
        if not records:
            return _empty_buildings_gdf()
        gdf = gpd.GeoDataFrame(records, geometry=geoms, crs="EPSG:4326")
        # enforce column order / dtypes
        for c in ["height", "num_floors", "min_height", "roof_height"]:
            if c not in gdf.columns:
                gdf[c] = None
        return gdf[["id", "height", "num_floors", "min_height", "roof_height", "geometry"]].copy()
    except Exception as e:
        print(f"[warn] overture fetch failed ({e}) — returning empty GDF")
        return _empty_buildings_gdf()
    finally:
        try:
            if con is not None:
                con.close()
        except Exception:
            pass


def _to_float(v) -> float | None:
    try:
        if v is None:
            return None
        f = float(v)
    except Exception:
        return None
    import math

    return f if math.isfinite(f) and f > 0 else None


__all__ = ["get_overture_buildings", "OVERTURE_S3_PATH", "OVERTURE_REGION", "OVERTURE_FALLBACK_RELEASE"]
