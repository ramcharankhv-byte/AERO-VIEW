"""04 - Generate underground utility runs and detect 3D conflicts.

Delegates to scripts/utilities.sql. Verifies afterwards that the deliberate
sewer-through-basement conflict actually fired -- if the conflict table is empty
the whole point of the 3D test is unproven, so that is a hard failure.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg  # noqa: E402
import project as proj  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

SCOPE = "(SELECT project_id FROM seed_ctx)"


def main():
    p = proj.parse_args()

    # Re-published rather than assumed: this script is runnable on its own, so
    # it cannot rely on 03_seed_db.py having left seed_ctx behind, and if it
    # did it could be reading a different project's scope than the one asked
    # for on the command line.
    proj.make_seed_ctx(p)

    if int(pg.scalar(f"SELECT count(*) FROM building WHERE project_id = {SCOPE}")) == 0:
        raise SystemExit(f"run scripts/03_seed_db.py first (no buildings for {p.slug})")

    pg.run_file(os.path.join(HERE, "utilities.sql"))

    n_util = int(pg.scalar(f"SELECT count(*) FROM utility WHERE project_id = {SCOPE}"))
    n_conf = int(pg.scalar(
        "SELECT count(*) FROM conflict c JOIN utility u ON u.id = c.a_id"
        f" WHERE u.project_id = {SCOPE}"))
    print(f"\nutilities={n_util}, conflicts={n_conf}")
    if n_util == 0:
        raise SystemExit("FAILED: no utility runs generated")
    if n_conf == 0:
        raise SystemExit(
            "FAILED: no conflicts detected -- the deliberate sewer/basement "
            "intersection did not fire, so ST_3DIntersects is not proving anything")

    used_sfcgal = pg.scalar("SELECT has_sfcgal()") == "t"
    print(f"3D test engine: {'SFCGAL ST_3DIntersects' if used_sfcgal else 'prism-exact 2D+Z fallback'}")


if __name__ == "__main__":
    main()
