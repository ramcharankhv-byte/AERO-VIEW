"""Tiny psql driver shared by the seeding scripts.

Deliberately shells out to psql instead of using psycopg2: the pipeline then has
zero Python dependencies, which matters because this project targets a Python
whose wheel coverage for the geo stack is still patchy. The Next.js API uses a
real driver (node-postgres); this is only for one-shot seeding.

Prefers `docker exec` into the compose container, falls back to a psql on PATH
driven by DATABASE_URL.

EVERY subprocess here decodes as UTF-8 explicitly. `text=True` alone uses the
locale codec, which on Windows is cp1252, and psql echoes back whatever it was
given -- including an OSM `name` tag in Telugu or Devanagari. That threw
UnicodeDecodeError from a reader thread, which does not propagate as a clean
failure: the call returned an empty stdout and the stage failed several lines
later with an unrelated message. It never surfaced while the only AOI was
Siripuram, whose names happen to be Latin-1 clean.
"""
import csv
import io
import json
import os
import shutil
import subprocess

CONTAINER = os.environ.get("ULPIN_PG_CONTAINER", "ulpin-postgis")
DB_USER = os.environ.get("ULPIN_PG_USER", "ulpin")
DB_NAME = os.environ.get("ULPIN_PG_DB", "ulpin")
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://ulpin:ulpin@localhost:55432/ulpin"
)


def _docker_available():
    if not shutil.which("docker"):
        return False
    probe = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return probe.returncode == 0 and probe.stdout.strip() == "true"


def _cmd(extra):
    if _docker_available():
        return ["docker", "exec", "-i", CONTAINER,
                "psql", "-U", DB_USER, "-d", DB_NAME, *extra]
    if shutil.which("psql"):
        return ["psql", DATABASE_URL, *extra]
    raise SystemExit(
        "Neither a running '%s' container nor psql on PATH.\n"
        "Start the database first:  docker compose up -d" % CONTAINER
    )


def run(sql, quiet=False):
    """Execute a SQL string (may contain psql backslash commands)."""
    proc = subprocess.run(
        _cmd(["-v", "ON_ERROR_STOP=1", "-f", "-"]),
        input=sql, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise SystemExit(f"psql failed:\n{proc.stderr.strip()}")
    if not quiet and proc.stdout.strip():
        print(proc.stdout.rstrip())
    return proc.stdout


def run_file(path, quiet=False):
    with open(path, encoding="utf-8") as fh:
        return run(fh.read(), quiet=quiet)


def scalar(sql):
    """Run a query and return the single value as text."""
    proc = subprocess.run(
        _cmd(["-tAc", sql]), capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise SystemExit(f"psql failed:\n{proc.stderr.strip()}")
    return proc.stdout.strip()


def rows(sql):
    """Run a query, return list of tuples of text values (tab separated)."""
    proc = subprocess.run(
        _cmd(["-tAF", "\t", "-c", sql]), capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise SystemExit(f"psql failed:\n{proc.stderr.strip()}")
    return [line.split("\t") for line in proc.stdout.splitlines() if line]


def copy_json(table, column, features):
    """Bulk-load GeoJSON features into `table(column jsonb)` via \\copy STDIN."""
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_ALL, lineterminator="\n")
    for feat in features:
        writer.writerow([json.dumps(feat, separators=(",", ":"))])
    script = (
        f"TRUNCATE {table};\n"
        f"\\copy {table} ({column}) FROM STDIN WITH (FORMAT csv)\n"
        f"{buf.getvalue()}\\.\n"
    )
    run(script, quiet=True)
