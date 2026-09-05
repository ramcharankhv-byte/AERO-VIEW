"""The seeding pipeline, end to end, for one project.

    npm run seed
    npm run seed -- --slug=hyderabad-banjara --name="Banjara Hills Ward" \\
        --bbox=78.4300,17.4100,78.4450,17.4250 --state=TS --district=HYD

WHY THIS FILE EXISTS. `npm run seed` used to be five `&&`-joined python
commands. npm appends `--` arguments to the END of the script string, so
`npm run seed -- --slug=x` would have handed the arguments to 05_export_static
alone and let the other four seed siripuram -- silently, and with the export
then writing a different project's directory from the one that was built. One
entry point takes the arguments once and passes the same ones to every stage.

Running it with no arguments reproduces siripuram exactly as before: the same
bbox, the same codes, the same input and output paths, and -- because
01_fetch_osm.py is a no-op when its committed extract is present -- without
touching the network at all.

The chain is: fetch -> clip DEM -> estimate -> hazard -> seed -> utilities -> roads
-> export.
The DEM stage (scripts/dem.py) is the one stage with third-party needs
(gdalwarp, rasterio or gdallocationinfo, pyproj); without them it prints why
and every building keeps its 12.0 m placeholder, exactly as before.
scripts/build_roads.mjs is part of it now; it produces data/api/<slug>/
roads.json, which the export step counts into projects.stats, so leaving it out
would have given every new project 0 streets and no centrelines to draw.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import project as proj  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))

# (label, argv). node steps take the same options in the same spelling as the
# python ones, so a reader does not have to know which is which.
def stages(p, passthrough):
    py = [sys.executable]
    return [
        ("fetch OSM", py + [os.path.join(HERE, "01_fetch_osm.py")] + passthrough),
        ("clip DEM", py + [os.path.join(HERE, "dem.py")] + passthrough),
        ("estimate heights", py + [os.path.join(HERE, "02_heights.py")] + passthrough),
        ("hazard exposure", py + [os.path.join(HERE, "hazard.py")] + passthrough),
        ("seed cadastre", py + [os.path.join(HERE, "03_seed_db.py")] + passthrough),
        ("utilities + conflicts", py + [os.path.join(HERE, "04_utilities.py")] + passthrough),
        ("streets", ["node", os.path.join(HERE, "build_roads.mjs"),
                     f"--slug={p.slug}", f"--name={p.name}"]),
        ("export snapshots", py + [os.path.join(HERE, "05_export_static.py")] + passthrough),
    ]


def main():
    argv = sys.argv[1:]
    # Parsed here purely to fail fast: a malformed bbox should be rejected
    # before the first Overpass request, not after it.
    p = proj.parse_args(argv)
    print(f"\n=== seeding {p.describe()} ===\n")

    passthrough = [a for a in argv if a.startswith("--")]

    plan = stages(p, passthrough)
    n = len(plan)
    for i, (label, cmd) in enumerate(plan, start=1):
        print(f"--- [{i}/{n}] {label} " + "-" * max(0, 50 - len(label)))
        result = subprocess.run(cmd, cwd=ROOT)
        if result.returncode != 0:
            # Mark the project failed rather than leaving it 'generating'
            # forever: the gallery renders the two differently, and a project
            # stuck mid-pipeline should look like a problem, not like work in
            # progress that nobody is doing.
            try:
                proj.set_status(p, "failed")
            except SystemExit:
                # No database to record it in. The stage's own error is the
                # message that matters; do not bury it under this one.
                pass
            raise SystemExit(
                f"\nseed: stage [{i}/{n}] {label} failed (exit {result.returncode}). "
                f"Nothing after it has run.")
        print()

    print(f"=== {p.slug} seeded ===")
    print(f"    viewer:   /p/{p.slug}")
    print(f"    snapshots: data/api/{p.slug}/")


if __name__ == "__main__":
    main()
