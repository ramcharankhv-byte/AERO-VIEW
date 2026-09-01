"""04 - Generate underground utility runs and detect 3D conflicts.

Delegates to scripts/utilities.sql. Verifies afterwards that the deliberate
sewer-through-basement conflict actually fired -- if the conflict table is empty
the whole point of the 3D test is unproven, so that is a hard failure.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    if int(pg.scalar("SELECT count(*) FROM building")) == 0:
        raise SystemExit("run scripts/03_seed_db.py first")

    pg.run_file(os.path.join(HERE, "utilities.sql"))

    n_util = int(pg.scalar("SELECT count(*) FROM utility"))
    n_conf = int(pg.scalar("SELECT count(*) FROM conflict"))
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
