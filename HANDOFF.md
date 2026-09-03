# HANDOFF — multi-project (multi-AOI) support

Branch `feat/multi-project`, 13 commits, cut from `feature/production-ui-3d` at
`7c62b4e`. All eight steps are done and none took its fallback.

**Two checks are red.** One (`check:roads`, a pick-tolerance assertion) was
already red before I started and is unchanged. The other (`check:edit`, one
assertion, snapshot backend only) **is a regression I introduced and did not
manage to isolate** — it is written up in full under "One thing is red, and it
is mine", including everything I measured and everything I did not establish.
Read that before you read the rest.

**Read this first, before anything else in this file.** The task was written
against a repository state that was **not in `HEAD`**. It was sitting
uncommitted in `stash@{0}` — seven API routes, the roads layer, the PATCH
endpoint, `check:roads` / `check:edit` / `check:rwd`, the monochrome token set.
`HEAD` has six routes and none of the rest, and on a clean `HEAD` checkout even
`npx tsc --noEmit` fails, because `.next/types` still carries a generated type
for an `app/api/roads/route.ts` that `HEAD` does not have.

I applied that stash with `git stash apply` (never `pop`, so **`stash@{0}` is
still there, untouched**) and committed it as an isolated first commit,
`multi-project(step 0)`. That commit is **not my work**. It is your WIP,
verbatim. Everything after it is mine.

If you disagree with that call: `git reset --hard c3a4481` recovers exactly the
WIP state and discards all of my work. `docs/multi-project-decisions.md` D0 has
the full reasoning.

---

## Status, one line each

| Step | | |
|---|---|---|
| 0 | — | Materialised the stashed WIP as the branch baseline. Not my work; see above. |
| 1 | **Done** | `projects` table, `project_id` on parcel/building/utility, id offsets, additive migration, committed registry snapshot. |
| 2 | **Done** | `ulpin.ts` and `ulpin_fmt()` take state/district/scheme. All 9,749 committed ULPINs round-trip byte-identical; SQL parity re-verified live for AP-VSP and TS-HYD. |
| 3 | **Done** | Seven routes at `/api/p/[slug]/…`, seven unscoped aliases sharing the handler body, `/api/projects[/:slug]`, snapshots moved by `git mv`. |
| 4 | **Done** | `data/projects/<slug>/edits.json`; the old global file is copied, never moved, and left in place. |
| 5 | **Done** | `/` is the gallery, `/p/[slug]` the viewer, one new store field, camera framed on the project bbox. |
| 6 | **Done** | Card grid, monochrome, inline SVG bbox sketch, no new dependency, no "New Project" affordance. |
| 7 | **Done** | `npm run seed -- --slug=… --bbox=…`, guard rails at entry, Overpass etiquette tightened. |
| 8 | **Done** | A real second AOI seeded from live Overpass: Banjara Hills Ward, Hyderabad. Not stubbed, not fabricated. |

**No step took its fallback.** Two commit boundaries are imprecise, and one
check regressed — both below.

---

## What to look at first

Three diffs carry the real risk.

**1. `lib/db.ts` (+536/−…).** Every read takes a slug now, and the SQL is
generated with a project filter whose placeholder number and parameter array
are built together — a mismatched `$n` does not error, it silently filters on
the wrong value, so `filter()` returns the clause and the params as one thing.
Three scopes, and the middle one is the subtle part: *scoped* (the `projects`
table knows the slug), *legacy* (there is **no** `projects` table, and the slug
is the demo project — every row in such a volume is siripuram, so the
unfiltered query is the correct one), *none* (serve the snapshot). Without
`legacy`, your existing `ulpin_pgdata` volume would have silently dropped to
the snapshot the moment you checked this branch out. That was not hypothetical:
the container running throughout this task was exactly that, and it is how the
scoped routes were first tested.

Also in here: `backend()` is answered **per project** now. It used to mean "is
PostGIS reachable at all", which with two projects would stamp
`x-ulpin-backend: postgis` on a response the snapshot served.

**2. `scripts/build_geometry.sql` and `scripts/utilities.sql`.** Two numbers per
row, and the distinction is the whole of multi-project support in SQL: `*_no` is
the per-project ordinal that goes into the ULPIN (parcel 0001 is *meant* to
exist in every district), `*_id` is that ordinal plus an offset past every other
project's rows, because it is the primary key the FKs and `/building/:id`
address rows by. For the first project seeded every offset is zero, which is why
none of siripuram's identifiers or ids moved. Also: `TRUNCATE … RESTART
IDENTITY` became a scoped `DELETE`, because truncating would erase a sibling
AOI — and that change had a consequence I had to chase down; see step 7 in the
decisions log.

**3. `data/api/projects.json` + `lib/projects.ts`.** The registry, and the
404-vs-503 gate. Worth reading because it decides what a user is told when
something is missing, and the two failures are genuinely different: "no such
project" and "your database is not running" must not be collapsed.

---

## Fallbacks taken, and why

**None of the eight steps took its fallback.** Two things went imprecisely and
you should know about both:

**A. Step 2's commit also carries Step 3's and Step 4's files.**
`git add -A lib components docs db` swept `lib/db.ts`, `lib/projects.ts`,
`lib/api/handlers.ts` and `lib/data/edits.ts` into `b5f38ed`. The brief forbids
rewriting history, so the commit stands as made. *Consequence:* the content is
grouped the way the brief describes, but the commit boundary between 2 and 3 is
not clean — read `b5f38ed` and `e4e1d50` together if the split matters.

**B. `ulpin_fmt()`'s new arguments landed in Step 1's commit, not Step 2's.**
`build_geometry.sql` cannot write a per-project ULPIN without them, so the SQL
half of Step 2 is a *prerequisite* for Step 1, not a successor. *Consequence:*
reverting Step 2 would leave the seven-argument `ulpin_fmt` in place. That is
harmless — its three code arguments default to `'AP'`, `'VSP'`, `'3D26'`, so a
call site passing only `(p, b, f, u)` emits exactly the string it always did.

---

## Things I changed that you did not ask for, and why

Each of these was a defect the work exposed rather than an improvement I went
looking for. All four are in the decisions log with the evidence.

1. **`db/02_functions.sql` now `DROP`s the old `ulpin_fmt` before creating the
   new one.** `CREATE OR REPLACE` matches on the *full* signature, so on an
   existing volume the seven-argument version was an **overload**, and
   `ulpin_fmt(42)` failed with *"function ulpin_fmt(integer) is not unique"* —
   which is every call site in `build_geometry.sql` at once. Caught by running
   the parity check against the live container rather than by reading the file.

2. **`conflict.id` is assigned explicitly instead of by its `serial`.** The
   scoped `DELETE` does not reset a sequence the way `TRUNCATE … RESTART
   IDENTITY` did, so a re-seed produced ids 13..24 where it used to produce
   1..12, walking further every time. `RESTART IDENTITY` is not available as a
   fix — it would renumber another project's conflicts.

3. **`scripts/pg.py` decodes psql output as UTF-8 explicitly.** `text=True`
   alone uses cp1252 on Windows; psql echoes back whatever it was given,
   including an OSM `name` tag outside Latin-1. The `UnicodeDecodeError` was
   raised in a subprocess *reader thread*, which does not propagate cleanly —
   the call returned empty stdout and the stage failed several lines later with
   an unrelated message. Latent for as long as the only AOI was Siripuram.

4. **`scripts/utilities.sql` takes the longest LINESTRING from
   `ST_OffsetCurve`.** Offsetting a hairpin makes the curve cross itself and
   PostGIS returns a MULTILINESTRING, which `utility.geom_3d` (declared
   `LineStringZ`) cannot hold — it aborted the whole transaction. Siripuram's
   street network never triggered it.

And one user-visible lie, fixed: **every generated address said ", Siripuram,
Visakhapatnam 530003"** — including 2,213 of them in Hyderabad — and the
DetailPanel's area-of-interest header was a hardcoded `"Siripuram,
Visakhapatnam"` sitting directly above correct counts for a different city.
Both read the project's own name now.

---
## One thing is red, and it is mine

**`npm run check:edit` fails one assertion on the SNAPSHOT backend.** Green on
PostGIS. Green at the step-0 baseline on the snapshot backend. So it is a
regression I introduced, and I could not isolate which change caused it.

```
[5] SAVE
  FAIL  success is confirmed
  PASS  the form closed
  PASS  the new name is shown
  PASS  the new storey count is shown
  PASS  the storey-count caveat survives the save
[6] THE SCENE WAS NOT REBUILT
  PASS  building entity count is unchanged — 768 -> 768
[7] PERSISTENCE
  PASS  the edit store was written
  PASS  it declares itself synthetic
  PASS  the record holds the edited fields
  PASS  no read-only field leaked into the store
  PASS  the edited building is still served
  PASS  the edited name / storey count / height survive
1 CHECK(S) FAILED
```

**What I established, by measurement:**

| | |
|---|---|
| PostGIS backend, my branch | **passes**, 3 separate runs |
| Snapshot backend, my branch | **fails**, 3 separate runs, including standalone on a freshly started dev server |
| Snapshot backend, step-0 baseline (`git checkout c3a4481`) | **passes** |
| Everything else in `check:edit` on the failing runs | passes, including all of `[7] PERSISTENCE` |

The assertion is a race against a self-clearing toast. `DetailPanel` renders
`Saved · revision N` and clears it with `setTimeout(clearSaved, 2600)`.
`check_edit` waits for the toast with `page.waitForFunction` — which polls on
**rAF**, and rAF is starved by Cesium on software WebGL — then re-reads the DOM
**1,200 ms later**. Instrumented on my branch against the snapshot backend, the
toast **appears 1,757 ms after the Save click and clears 2,708 ms after that**.
So there is roughly 1.4 s of slack, and something in my changes consumed it.

**What I did NOT establish:** which change lengthened the click-to-toast
latency. The PATCH itself is not the culprit — measured over the wire at
**28–46 ms** on the snapshot backend. It is client-side, between the response
landing and the panel painting.

**I deliberately did not "fix" it by loosening the assertion.** Editing an
acceptance script until it goes green is the one repair that makes the branch
look better and the system worse.

**Reproduce it:**

```bash
docker compose stop
npx next dev -p 3210
ULPIN_URL=http://localhost:3210/p/siripuram \
ULPIN_EDITS_PATH=/tmp/ulpin-edits node scripts/check_edit.mjs
```

and the same with `docker compose start` first, to see it pass.

---

## Test output, both runs, verbatim

### Docker UP (PostGIS)

```console
$ npx tsc --noEmit
[exit 0]

$ npm test
ℹ tests 26   ℹ pass 26   ℹ fail 0
[exit 0]

$ npm run verify:ui
[1] CITY … [10] CONSOLE          47 PASS
ALL CHECKS PASSED
[exit 0]

$ npm run check:roads
[4] CLICK TOLERANCE
  PASS  the tight pick genuinely misses off the line — at +8,0
        tolerance curve: 9px:0  13px:0  17px:0  21px:0  25px:0  31px:0
  FAIL  the widened pick recovers the street off the line
        — no recovery up to 31px at offset 8,0
1 CHECK(S) FAILED                25 PASS
[exit 1]        <-- PRE-EXISTING, identical at baseline

$ npm run check:edit
[1] … [8]                        39 PASS
ALL CHECKS PASSED
[exit 0]

$ npm run check:rwd
=== 1680x950 ===  chrome monochrome / scene in colour / no console errors
                  panels within viewport / no collisions / attribution visible
=== 1280x800 ===  (all six PASS)
=== 834x1112 ===  (all six PASS)
=== 390x844  ===  (all six PASS)
ALL CHECKS PASSED
[viewer exit 0]
=== 1680x950 (gallery) ===  chrome elements 23 · PASS: chrome is monochrome
                            scene colour audit : n/a (no canvas on this page)
                            PASS: no console errors
                            PASS: all panels within the viewport
                            PASS: no panel collisions
                            attribution        : n/a (no map data on this page)
=== 1280x800 (gallery) ===  (all four PASS)
=== 834x1112 (gallery) ===  (all four PASS)
=== 390x844  (gallery) ===  (all four PASS)
ALL CHECKS PASSED
[gallery exit 0]
```

### Docker DOWN (committed snapshots)

```console
$ npx tsc --noEmit
[exit 0]

$ npm test
ℹ tests 26   ℹ pass 26   ℹ fail 0
[exit 0]

$ npm run verify:ui
ALL CHECKS PASSED
[exit 0]

$ npm run check:roads
  FAIL  the widened pick recovers the street off the line
        — no recovery up to 31px at offset 8,0
1 CHECK(S) FAILED
[exit 1]        <-- same pre-existing failure

$ npm run check:edit
[5] SAVE
  FAIL  success is confirmed
1 CHECK(S) FAILED
[exit 1]        <-- MINE. See "One thing is red" above.

$ npm run check:rwd
ALL CHECKS PASSED   [viewer exit 0]
ALL CHECKS PASSED   [gallery exit 0]
```

Alias vs scoped route, byte-for-byte, on the snapshot backend:

```
buildings   alias == scoped: true
parcels     alias == scoped: true
utilities   alias == scoped: true
conflicts   alias == scoped: true
roads       alias == scoped: true
```

`POST /api/query` returns the identical stack on both backends:

```
parcel    AP-VSP-3D26-0048            K. Venkata Rao
building  AP-VSP-3D26-0048-001        Kanaka Nivas    z 12.00..28.00
floor     AP-VSP-3D26-0048-001-01     Level 1         z 15.20..18.40
unit      AP-VSP-3D26-0048-001-01-02  B02             z 15.35..18.05
```

**But not at the point the README documents.** The brief's acceptance expects
four rows at `{"lon":83.3157,"lat":17.7268,"z":16.7}`. That point returns
**zero** rows — and so does the unchanged SQL run directly in psql, and so does
the unchanged JS prism test run directly over the unchanged `parcels.json`. The
example point drifted out of its parcel at some earlier re-seed; this branch did
not move it. The stack above is the same shape, owner and z-extents at the
parcel it was clearly written against. **The README's example block is left as
it is** — correcting it is not in this task's scope and the numbers in it are
data-provenance-adjacent. Your call.

---

## The camera grep

```console
$ grep -rn 'flyTo\|zoomTo\|lookAt' --include=*.ts --include=*.tsx \
    app components lib | grep -v 'components/globe/CameraDirector.tsx'
$ echo $?
1
```

Nothing. Widening it to `scripts/` returns exactly one line, and it is a
comment in a test harness, not a call:

```
scripts/check_basemap.mjs:241:  // digits. An actual camera move -- a stray flyTo or re-frame on swap, the
```

`setView` across `app`, `components` and `lib` is **one** call, at
`lib/cesium/setup.ts:102` — `frameInitialCamera`, the documented
construction-time exception, which now takes the project's bbox as an argument.
Every other hit is `setViewMode` / `resetView`, which are store actions.

`projectSlug` has exactly one writer:

```
app/p/[slug]/ProjectViewer.tsx:51:    useViewStore.setState({ projectSlug: project.slug });
components/ui/DataErrorNotice.tsx:26:  const slug = useViewStore((s) => s.projectSlug);   <- read
lib/store.ts:34, 186                                                          <- declaration
```

There is no setter for it on the store, deliberately.

---

## Snapshot diff for `data/api/siripuram/`

**Zero bytes changed.** All six files are pure 100% renames:

```console
$ git diff --find-renames --stat c3a4481..HEAD -- data/api/siripuram …
 data/api/{ => siripuram}/buildings.json | 0
 data/api/{ => siripuram}/conflicts.json | 0
 data/api/{ => siripuram}/detail.json    | 0
 data/api/{ => siripuram}/parcels.json   | 0
 data/api/{ => siripuram}/roads.json     | 0
 data/api/{ => siripuram}/utilities.json | 0
 6 files changed, 0 insertions(+), 0 deletions(-)

 rename data/api/{ => siripuram}/buildings.json (100%)
 rename data/api/{ => siripuram}/conflicts.json (100%)
 rename data/api/{ => siripuram}/detail.json    (100%)
 rename data/api/{ => siripuram}/parcels.json   (100%)
 rename data/api/{ => siripuram}/roads.json     (100%)
 rename data/api/{ => siripuram}/utilities.json (100%)
```

Note this is **stronger than the invariant asked for**: the brief allowed "an
added `project_id` field". There is none. The export queries do not emit
`project_id` into feature properties — it is a scoping column, not a fact about
a building — so the files did not need to change at all.

Re-verified independently by sha256 after running the full `npm run seed`, and
again after seeding the second project:

```
c461920462bf3380  buildings.json
246482a5d2cfb707  parcels.json
5dab2879cb9d4002  utilities.json
0120e7ad502db492  conflicts.json
d8096b23cfe5d059  detail.json
924b483e7fc7c451  roads.json
```

A **re-run** of `npm run seed` reproduces every entity exactly (384 / 325 /
1,810 / 6,438 / 301 / 131 / 12, content-identical field by field) but does not
reproduce the files byte for byte — `detected_at` timestamps move, and
FeatureCollection order is whatever `json_agg` returns, which has never had an
`ORDER BY` and is not id-ordered in the committed files either. I restored the
committed files with `git checkout` after testing, rather than letting a
cosmetic reordering into the diff.

---

## Things for you to run

**Migrate an existing PostGIS volume** (I already ran this against the container
that was up, and it is idempotent, so this is only for a different machine):

```bash
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
  -f - < db/migrations/001_multi_project.sql
```

**Delete the directory I left behind.** A typo of mine (`--slug=BadSlug`, which
the CLI lower-cases to `badslug`) ran a fetch before I caught it. The brief
forbids me deleting anything under `data/`, so I left it: untracked,
unreferenced, no registry row, nothing points at it.

```bash
rm -rf "data/projects/badslug" "data/api/badslug"
```

**`data/edits.json` also did not exist when I started.** `scripts/check_edit.mjs`
creates it while asserting that a save persists, so the baseline run brought it
into existence with a test record (`"Edited Test Block QX7"`). It is gitignored,
it never enters a diff, and Step 4's adoption copy is exercised against it. Left
in place, per the brief.

**Regenerate the second project from scratch**, if you ever want to:

```bash
npm run seed -- --slug=hyderabad-banjara --name="Banjara Hills Ward" \
  --bbox=78.4300,17.4100,78.4450,17.4250 --state=TS --district=HYD
```

It needs no network — `data/projects/hyderabad-banjara/raw_*.geojson` are
committed, so stage 1 is a no-op.

**State I left the machine in:** the `ulpin-postgis` container is **running**,
as it was when I started (it is migrated now). No dev server is listening. The
only untracked path is `data/projects/badslug/`.

---

## What I would do next

1. Chase the `check:edit` toast regression on the snapshot backend — instrument
   the client between the PATCH response landing and `finishSave` painting; the
   1.76 s click-to-toast latency is where it hides.
2. Give the utility authorities and owner organisations a per-project source.
   Naming GVMC and APEPDCL as the operators of pipes in Hyderabad is the one
   remaining place this app says something confidently wrong about the world.
3. Decide whether `data/api/*/detail.json` belongs in git at all — the second
   project's is 17 MB, and a third would double that.
