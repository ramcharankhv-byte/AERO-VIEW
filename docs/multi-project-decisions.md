# Multi-project (multi-AOI) — decisions log

Append-only. Every judgement call, every place the repository contradicted the
task brief, every fallback taken, with the reason.

Branch: `feat/multi-project`, cut from `feature/production-ui-3d` @ `7c62b4e`.

---

## D0 — The state the brief assumes was stashed, not committed

The brief is written against a repository that has seven API routes, a roads
layer, a per-building PATCH endpoint with `data/edits.json`, and three
acceptance scripts (`check:roads`, `check:edit`, `check:rwd`). **None of that is
in `HEAD` (`7c62b4e`).** `HEAD` has six routes, no roads, no edits, no PATCH,
and `package.json` carries only `check:basemap` and `check:photoreal`.

It is all present in `stash@{0}` (`07a1931`, "WIP on feature/production-ui-3d"),
83 files / +5757 lines — `app/api/roads/route.ts`, `components/layers/RoadsLayer.tsx`,
`lib/data/edits.ts`, `lib/data/building-schema.ts`, `lib/mock/*`, `lib/ui-store.ts`,
`lib/use-layout.ts`, `components/ui/shell/*`, `scripts/build_roads.mjs`,
`scripts/check_roads.mjs`, `scripts/check_edit.mjs`, `scripts/shoot.mjs`, and the
monochrome token set in `app/globals.css`.

Corroborating evidence that this is the intended base and not an abandoned
experiment: on a clean `HEAD` checkout `npx tsc --noEmit` **fails**, because
`.next/types/app/api/roads/route.ts` — a stale Next-generated type — imports
`app/api/roads/route.js`, which does not exist at `HEAD`. The last build in this
working directory was made against the stashed tree.

**Decision.** Applied the stash onto `feat/multi-project` with `git stash apply`
(never `pop`), so `stash@{0}` survives untouched and is still recoverable, and
committed it as an isolated `multi-project(step 0)` commit before any of my own
work. Rationale: building the brief's steps 3, 4 and 6 on `HEAD` is impossible —
there is no seventh route to scope, no edits file to move, and no colour audit to
pass — so a `HEAD`-based branch would have delivered a fraction of the task and
would then have conflicted catastrophically with the WIP on the first `git stash
pop`. `git stash apply` is non-destructive, and isolating it in its own commit
keeps my diff separable from the pre-existing work.

**Consequence for review:** `multi-project(step 0)` is *not my work*. It is the
stash, verbatim. Review it as "the WIP I was already carrying", and review
`multi-project(step 1..8)` as the multi-project change. If you disagree with
this call, `git reset --hard <step 0 sha>` recovers exactly the WIP state and
discards everything I built.

## D1 — Facts in the brief that do not match the repository, even after D0

| Brief says | Repository (post-D0) | What I did |
|---|---|---|
| "131 streets" in the acceptance counts | `data/api/roads.json` — see the recorded count in the acceptance run | Report the real number, do not assert 131 |
| `npm run seed -- --slug=…` threads through "scripts/01–05, build_geometry.sql, utilities.sql and build_roads.mjs" | `npm run seed` is a five-command `&&` chain of *python* scripts; `build_roads.mjs` is a separate `build:roads` script and is **not** in the seed chain | Thread the CLI args through 01–05 + the two SQL files, and add `build_roads.mjs` to the scoped chain |
| `check:rwd` audits "0 off-palette chrome elements" | `scripts/shoot.mjs` audits computed styles for chroma with `--danger` sanctioned, plus an inverted framebuffer check that the *scene* must carry chroma | Same thing, different wording. Gallery has no canvas, so the scene half is inapplicable there — noted at the point of use |
| Snapshots are "`data/api/`" | `data/api/` also holds `roads.json`, which has no PostGIS table behind it | Moves with the rest into `data/api/siripuram/`; `x-ulpin-roads: derived` preserved |

## Baseline

Recorded on `feat/multi-project` immediately after D0's `git stash apply`, before
any edit of mine. Dev server: `npx next dev -p 3210`, `ULPIN_URL=http://localhost:3210/`.
Docker `ulpin-postgis` was **already running** when this task began (up 35 h,
healthy), so the baseline is the PostGIS-backed one.

```console
$ npx tsc --noEmit
[exit 0]

$ npm test
ℹ tests 21
ℹ pass 21
ℹ fail 0
[exit 0]

$ npm run verify:ui          # ULPIN_URL=http://localhost:3210/
[1] CITY ... [10] CONSOLE
ALL CHECKS PASSED
[exit 0]

$ npm run check:roads
[4] CLICK TOLERANCE
  FAIL  the widened pick recovers the street off the line
        — no recovery up to 31px at offset 8,0
1 CHECK(S) FAILED
[exit 1]

$ npm run check:edit
[4] VALIDATION
  FAIL  nothing was written while validation was failing
        — C:\Aero View\data\edits.json exists
1 CHECK(S) FAILED
[exit 1]

$ npm run check:rwd          # 1680x950 1280x800 834x1112 390x844
=== 1680x950 ===  PASS chrome monochrome / scene in colour / no console errors
                  PASS panels within viewport / no collisions / attribution visible
=== 1280x800 ===  (all six PASS)
=== 834x1112 ===  (all six PASS)
=== 390x844  ===  (all six PASS)
ALL CHECKS PASSED
[exit 0]
```

**Two of the six are red at baseline, and neither is mine.** Per the brief both
are treated as pre-existing and left alone.

- `check:roads` — *"the widened pick recovers the street off the line"*. A
  pick-tolerance assertion against a scene rendered by headless Chrome on
  SwiftShader software WebGL. Every other roads check passes, including the two
  that matter most (streets are tagged and pickable; a street never steals a
  building's click). Not touched.
- `check:edit` — *"nothing was written while validation was failing"*. This one
  is an **ordering artefact of the baseline run itself**, not a defect. The
  assertion requires `data/edits.json` to be absent; the *first* baseline pass
  of `check:edit` (run minutes earlier, with `ULPIN_EDITS_PATH` pointed at a
  scratch file while the dev server was not, so its own persistence assertion
  looked in the wrong place) created it. Re-running with the env matched shows
  **34 of 35 checks pass**, including the whole `[7] PERSISTENCE` block and the
  `[6] THE SCENE WAS NOT REBUILT` entity-count assertion (768 -> 768). The one
  failure is the precondition, and the precondition is now dirty.

`verify:ui` should also be read with one caveat. Its **first** run in this
session reported `4 CHECK(S) FAILED`, all in the timing-sensitive skeleton
probe (`skeleton is replaced by real content`), which throttles
`/api/building/:id` to 1500 ms and then samples the DOM on a fixed sleep. The
immediately following identical run was `ALL CHECKS PASSED`. It is flaky under
software WebGL, not broken; the green run is recorded above as the baseline
because it is the reproducible one, and this note exists so a red skeleton
check in the final run is not read as a regression.

### A note on `data/edits.json`

It did **not** exist when this task began. `scripts/check_edit.mjs` creates it
as part of asserting that a save persists, so the baseline run brought it into
existence with a test record (`"Edited Test Block QX7"`). It is gitignored and
therefore never appears in a diff. It has been left in place rather than
deleted — the brief says it must survive — and it turned out to be useful: it
is the file Step 4's one-time adoption copy is exercised against.


---

## Step 1 — Projects table and registry

**Done.** `projects` table, `project_id` on parcel / building / utility, an
additive migration for an existing volume, and a committed registry snapshot.

**D1.1 — Row ids stay globally unique; only the ULPIN number restarts.**
The brief says parcel numbering is scoped per project. It is — but only the
*ULPIN* number. `parcel.id` is a primary key that `building.parcel_id`,
`/api/p/<slug>/building/:id` and every FK address rows by, and restarting it at
1 per project would collide on the second AOI. So `scripts/build_geometry.sql`
now computes two numbers per row: `*_no`, the per-project ordinal that goes
into the ULPIN, and `*_id`, that ordinal plus an offset past every other
project's rows. For the first project seeded every offset is zero, which is
what keeps siripuram's ids *and* its identifiers byte-identical.

**D1.2 — `ulpin_fmt()`'s new arguments landed in this step, not step 2.**
`build_geometry.sql` cannot write a per-project ULPIN without them, so the SQL
half of Step 2 is a prerequisite for Step 1 rather than a successor to it. The
three new arguments default to `'AP'`, `'VSP'`, `'3D26'`, so a call site that
passes only `(p, b, f, u)` emits exactly the string it emitted before. Step 2's
commit carries the TypeScript half and the parity assertion. If Step 2 were
ever reverted, this signature would remain — harmlessly, since its defaults
reproduce the old literal exactly.

**D1.3 — `TRUNCATE` became a scoped `DELETE`.**
`03_seed_db.py` used to `TRUNCATE parcel, building, floor, unit, conflict
RESTART IDENTITY CASCADE`. That would erase a sibling AOI the moment one
existed. Re-seeding now deletes only the project being seeded, from
`build_geometry.sql` (which is where the scope is known), and the cascade from
`parcel` carries building → floor → unit with it.

**D1.4 — `seed_ctx`, not `psql -v`.**
`pg.py` pipes each SQL file through a separate `psql -f -`, so a `\set`
variable does not survive from one invocation to the next and the two SQL files
would each have to be told the scope separately — and could disagree.
`scripts/project.py` writes a one-row `seed_ctx` table instead; both files read
it.

**D1.5 — `created_at` is pinned, not `now()`.**
`data/api/projects.json` is a committed snapshot of the `projects` row. A
`created_at` defaulted to `now()` would differ from it after every `initdb`, so
the demo row's timestamp is set explicitly to `2026-09-01T04:49:47Z` — when the
AOI's data first entered the repository (`git log` on `data/api/buildings.json`).

**D1.6 — The table is `projects` (plural), against the schema's own convention.**
Every other table here is singular. The brief names it `projects` explicitly
and that is what shipped; the deviation is called out in a comment at the
definition so the next reader does not have to wonder whether it was an
accident.

**D1.7 — Registry stats are computed, and they match the brief exactly.**
384 buildings · 325 parcels · 131 streets · 1,810 floors · 6,438 units ·
301 utility runs · 12 conflicts, read out of the committed snapshots rather
than typed in. `streets` is not a database count: there is no road table, so it
is the feature count of the derived `roads.json`, and it is 0 for a project
whose street artefact has not been built.

---

## Step 2 — ULPIN takes state and district from the project

**Done, and proven byte-identical.**

`generate()`, `parse()`, `levelOf()`, `parentOf()` and `ulpin_fmt()` all take
the revenue codes now, defaulting to AP/VSP/3D26. The defaults are the whole
mechanism by which this is invisible to the demo project.

**D2.1 — The proof, not the argument.**
Every ULPIN in `data/api/siripuram/` was parsed and regenerated through the new
code and compared to the original string:

```
ULPINs checked : 9749
mismatches     : 0
```

and `ulpin_fmt()` was re-run against the live PostGIS for both projects:

```
AP-VSP-3D26-0042 | ...-007 | ...-007-00 | ...-007-B2 | ...-007-05-03
TS-HYD-3D26-0042 | ...-007 | ...-007-00 | ...-007-B2 | ...-007-05-03
```

matching the fixed expectations now asserted in `lib/ulpin.test.ts`.

**D2.2 — `parse()` stays strict by default; `levelOf`/`parentOf` do not.**
The brief says to extend the parity assertion, not to change what `parse()`
accepts. An existing test requires `parse('XX-VSP-3D26-0042')` to be `null`, and
a regex loosened to "any two letters" would have broken it. So `parse(x)` still
validates against the demo project's codes, and `parse(x, 'any')` — or
`parse(x, someProjectsCodes)` — is the opt-in. `levelOf` and `parentOf` default
to `'any'` instead, because they answer questions ("how deep does this go",
"what contains it") whose answers do not depend on which district minted the
identifier; `parentOf` re-emits the prefix it found, so walking up a TS-HYD
identifier never silently relabels it AP-VSP.

**D2.3 — `UlpinParts` did not gain fields.**
`codesOf()` is a separate function rather than two more keys on `parse()`'s
return value, because an existing test deep-compares that object
(`assert.deepEqual(parse('...b2'), { parcel: 42, building: 7, floor: -2 })`)
and adding keys would have failed it for no gain.

**D2.4 — `CREATE OR REPLACE` was not enough, and this would have bitten hard.**
Postgres matches `CREATE OR REPLACE FUNCTION` on the *full* signature, so the
seven-argument `ulpin_fmt` was created as an **overload** beside the old
four-argument one on the running volume. `SELECT ulpin_fmt(42)` then failed
with *"function ulpin_fmt(integer) is not unique"* — which is every call site in
`build_geometry.sql` at once, on any existing database. `db/02_functions.sql`
now drops the old signature first. Caught by running the parity check against
the live container rather than by reading the file.

**D2.5 — Two UI call sites became permissive.**
`TopBar`'s search box and `UlpinCard` both call `parse()` on an identifier that
belongs to the project already on screen. Left strict they would have rejected
every ULPIN of every project outside Visakhapatnam — a blank ULPIN card on the
second AOI. Both now pass `'any'`, with the reason at the call site.

---

## Step 3 — Scoped API routes

**Done.** Seven cadastre endpoints at `/api/p/[slug]/…`, seven unscoped aliases,
`GET /api/projects` and `GET /api/projects/[slug]`, snapshots moved with
`git mv`.

**D3.0 — Step 2's commit carries some of Step 3's files.**
`git add -A lib components docs db` in the Step 2 commit swept in `lib/db.ts`,
`lib/projects.ts`, `lib/api/handlers.ts` and `lib/data/edits.ts`, which are
Step 3 and Step 4 work. The brief forbids rewriting history, so the commit
stands as made and this is the correction. The *content* is grouped as the
brief describes; only the commit boundary is off. Read commits 2 and 3 together
if the split matters to you.

**D3.1 — Handler bodies live in `lib/api/handlers.ts`, not in the routes.**
"Byte-identical on the snapshot backend" between `/api/buildings` and
`/api/p/siripuram/buildings` is a property you either get by construction or
verify forever. Both route files call the same function; the route file is five
lines. Measured after the fact anyway, over the wire:

```
buildings  identical: true  339526 bytes
parcels    identical: true  307171 bytes
utilities  identical: true  205775 bytes
conflicts  identical: true    4155 bytes
roads      identical: true   94199 bytes
```

**D3.2 — `backend()` became per project, and that is a behaviour change.**
It used to answer "is PostGIS reachable at all". With two projects that is the
wrong question: with the database up and a second project that exists only as a
snapshot, the old probe would have stamped `x-ulpin-backend: postgis` on a
response the snapshot served. It now answers "did PostGIS serve *this*
project". For siripuram with the database running it still returns `postgis`,
which is what the acceptance scripts assert and what shipped.

**D3.3 — A third scope, `legacy`, for an unmigrated volume.**
`scopeFor(slug)` resolves to one of: *scoped* (the `projects` table knows the
slug — filter on `project_id`), *legacy* (there is no `projects` table, and the
slug is the demo project — every row in such a database is siripuram, so the
unfiltered query is the correct one), or *none* (serve the snapshot). Without
`legacy`, an existing `ulpin_pgdata` volume would have silently dropped to the
snapshot the moment this branch was checked out. This was not hypothetical:
the container running during this task was exactly that, and it is how the
scoped routes were tested before the migration was applied.

**D3.4 — A missing roads artefact is an empty collection, not a 404.**
There is no road table in PostGIS, so `getRoads()` is snapshot-only. A project
whose `build_roads.mjs` has not run has no `roads.json`, and answering 404 for
it would read as "this project does not exist". It returns an empty
FeatureCollection carrying a `_disclaimer` that says the artefact has not been
built. `x-ulpin-roads: derived` is unchanged.

**D3.5 — One new header, `x-ulpin-project`.**
Additive. `x-ulpin-backend` and `x-ulpin-roads` are untouched in name, value and
the conditions that produce them. The new one exists because with two URLs
resolving to the same data, "which project did I actually get" is otherwise
unanswerable from a response.

**D3.6 — The error contract, verified over the wire.**

```
GET /api/p/nowhere/buildings      -> 404  {"error":"project not found", ...}
GET /api/projects/nowhere         -> 404
GET /api/p/ghost-ward/buildings   -> 503  {"error":"project unavailable",
                                           "detail":"PostGIS is required for
                                           this project ..."}
GET /api/projects/ghost-ward      -> 503
```

The 503 was probed by adding a temporary registry entry with no snapshot
directory, then reverting `data/api/projects.json` with `git checkout`. Neither
path throws.

**D3.7 — `POST /api/query` at the README's example point returns 0 rows, and
did before this branch.**
The brief's acceptance list expects four rows at
`{"lon":83.3157,"lat":17.7268,"z":16.7}`. It returns none — and so does the
unchanged SQL run directly in psql, and so does the unchanged JS prism test run
directly over the unchanged `parcels.json`. The example point drifted out of
its parcel at some earlier re-seed; this branch did not move it. The stack
itself is intact and identical in shape, owner and z-extents at the parcel it
was clearly written against:

```
$ curl -s -X POST localhost:3210/api/query -H 'Content-Type: application/json' \
    -d '{"lon":83.3158,"lat":17.72644,"z":16.7}'

parcel    AP-VSP-3D26-0048            K. Venkata Rao
building  AP-VSP-3D26-0048-001        Kanaka Nivas      z 12.00..28.00
floor     AP-VSP-3D26-0048-001-01     Level 1           z 15.20..18.40
unit      AP-VSP-3D26-0048-001-01-02  B02               z 15.35..18.05
```

The README's example block is **left as it is**: correcting it is not in this
task's scope, and the numbers in it are data-provenance-adjacent. Flagged in
HANDOFF.md instead, with the working point above.

**D3.8 — `build_roads.mjs` took a `--slug` early.**
It writes into `data/api/<slug>/`, so it had to learn about projects the moment
the snapshots moved. Re-run for siripuram it produces `roads.json` **byte for
byte identical** to the committed one (94,199 bytes both sides), which is the
check that the slug plumbing changed only the path.

---

## Step 4 — Per-project edits

**Done.** `data/projects/<slug>/edits.json`, still gitignored, with a one-time
copy of the old global store into the demo project's path.

**D4.1 — `ULPIN_EDITS_PATH` means a base directory now, but a `.json` value
still works.**
The brief says to extend it to mean a base directory. Taken literally, an
existing development setup pointing it at `…/edits.json` would have started
creating a *directory* with that name. Both `lib/data/edits.ts` and
`scripts/check_edit.mjs` therefore read a value ending in `.json` as "the
directory that file was in". One rule, implemented in both places, stated in
both places.

**D4.2 — The adoption copy is skipped when `ULPIN_EDITS_PATH` is set.**
Found by running `check:edit`. Its `[4] VALIDATION` step asserts that *nothing
was written* while validation was failing, which requires the store not to
exist yet — and that is exactly why it points the variable at a scratch
directory. The adoption copy was helpfully seeding that scratch directory from
`data/edits.json` and failing the precondition on an otherwise clean run. An
explicit override means "use this store", not "seed this store from the old
one", so adoption now runs only against the default location.

**D4.3 — Copy, and say so out loud.**
On first read of the demo project's store, if `data/edits.json` exists and the
per-project file does not, it is **copied** — never moved, never deleted — and
the copy prints:

```
[edits] copied the pre-multi-project store C:\Aero View\data\edits.json ->
        …\edits\siripuram\edits.json. The original has been left in place,
        not moved.
```

Verified in the dev server's log.

**D4.4 — Result: `check:edit` is greener than baseline.**
34/34 rather than 34/35, and the one that changed is the precondition
D4.2 fixed. Every guarantee the brief lists is asserted and passing: 400 for
coordinates and ULPIN, 422 for validation failures, the shared schema, the
pessimistic save, the pure overlay over the pristine snapshot, and the
entity-count-unchanged assertion (768 -> 768). The scoped route was probed
separately and behaves identically:

```
PATCH /api/p/siripuram/building/2  {"ulpin":"X"}   -> 400
PATCH /api/p/siripuram/building/2  {"floors":-3}   -> 422
PATCH /api/p/nowhere/building/2    {"name":"x"}    -> 404
PATCH /api/p/siripuram/building/2  {"name":"…"}    -> 200, x-ulpin-edit-rev: 1
```

and the store it writes carries `"project": "siripuram"`, so a file that ends
up in the wrong directory says so about itself.

**D4.5 — No fallback needed.** The namespaced-key fallback (`<slug>:<id>` in
one global file) was not used.

---

## Step 5 — Routing and viewer parameterisation

**Done.** `/` is the gallery (rendered, not redirected); `/p/[slug]` is the
viewer, unchanged in behaviour.

**D5.1 — `projectSlug` is written in a `useState` initialiser, not an effect.**
The brief says written once on mount by the page and by nothing else. An effect
would not have satisfied "before anything reads it": React runs effects
child-first, so `CesiumRoot`'s mount effect — which is what issues the boot
fetches — would have run against a `null` slug and been told the right one
afterwards. A `useState` initialiser runs during the parent's first render,
before any child mounts. Under StrictMode React may invoke it twice; writing
the same slug twice is idempotent and there is no other writer.

There is deliberately **no setter** on the store for it. Adding one would
invite a second writer, and "which project am I looking at" changing under a
live scene is a page navigation, not a state change.

**D5.2 — The scene takes the project as a prop as well.**
Belt and braces, and it is the prop that actually carries the data:
`Scene -> CesiumRoot -> ViewerCtx`. The store field exists for chrome that sits
*outside* the Cesium tree (`DataErrorNotice` needs it to retry the right
project's fetch), where there is no viewer context to read.

**D5.3 — `frameInitialCamera(viewer, bbox)`, still the only `setView`.**
It takes the project's bbox instead of reading a module constant. The height it
frames at is `frameHeightFor(bbox)`, which returns exactly **1200** for a bbox
the size of Siripuram's — so the demo project opens on the identical pose — and
scales with the larger dimension for anything else, so a smaller ward does not
open as a speck.

**D5.4 — `CameraDirector`'s `AOI_CENTRE` constant is gone.**
It was `{ lon: 83.31875, lat: 17.723 }`, used by the city and underground
poses. Pressing Reset on a Hyderabad project would have flown the camera to
Visakhapatnam. It now derives the centre from `project.bbox` off the viewer
context, and the city pose reads its height from the same `frameHeightFor` the
initial pose does, so Reset still returns to exactly the opening pose. **No new
camera call sites**; the grep is below and in HANDOFF.md.

**D5.5 — `lib/cesium/setup.ts`'s `AOI` constant survives, on purpose.**
`lib/cesium/imagery.ts` bounds the optional drone-orthophoto provider to it,
and that tile pyramid is a flight over Siripuram specifically — feeding it
another project's bbox would ask a tile server for photographs that do not
exist. Documented at the constant.

**D5.6 — StatusBar reads the project name from the data, not from a new store
field.**
The brief allows the store exactly one new field and it is `projectSlug`. The
buildings FeatureCollection already carries the project's name in `aoi`, on
both backends, so the status bar reads it there — where it cannot disagree with
the data on screen. `verify_ui.mjs`'s `AOI named` assertion passes unchanged
for the demo project.

The brief describes this as "alongside the existing backend indicator". There
is no postgis/snapshot indicator in the StatusBar — that lives on the wire as
`x-ulpin-backend`; what the bar shows next to the place name is the imagery and
terrain sources. The project name sits where the hardcoded
`"Siripuram, Visakhapatnam"` used to, which is that position.

**D5.7 — The acceptance scripts' default URL moved to `/p/siripuram`.**
`/` is the gallery now, so a script pointed at it would drive a page with no
globe. `ULPIN_URL` still overrides. The API paths inside those scripts are
untouched — they use the unscoped aliases, which is exactly why the aliases
exist.

**D5.8 — The camera grep, verbatim.**

```console
$ grep -rn 'flyTo\|zoomTo\|lookAt' --include=*.ts --include=*.tsx \
    app components lib | grep -v 'components/globe/CameraDirector.tsx'
$ echo $?
1
```

Nothing. Widening it to `scripts/` returns one line, and it is a comment in a
test harness, not a call:

```
scripts/check_basemap.mjs:241:  // digits. An actual camera move -- a stray flyTo or re-frame on swap, the
```

`setView` across `app`, `components` and `lib` is one call, in
`lib/cesium/setup.ts:102` — `frameInitialCamera`, the documented
construction-time exception. Everything else the grep finds is `setViewMode` /
`resetView`, which are store actions.

---

## Step 6 — Gallery

**Done.** A card grid, monochrome, no new dependency.

**D6.1 — Every class is one the chrome already defines.**
`glass`, `panel-title`, `row-label`, `chip`, `tint-hover`, and the
`ink`/`muted`/`edge`/`edgeStrong` tokens from `tailwind.config.ts`. No new CSS
was authored for the gallery — not a rule, not a token.

**D6.2 — `--danger` appears once, and it is sanctioned.**
On the status chip of a project whose generation *failed*. That is the same use
the conflict count in the StatusBar makes of it: a state the user must not
miss. Every other chip is grey.

**D6.3 — The bbox sketch is inline SVG in `currentColor`.**
No MapLibre, no tile fetch, no dependency. It draws the bbox at its **real**
aspect ratio — metres, not degrees, so at 17.7 N a square in degrees does not
render as a square — with a fixed 4x4 graticule for scale and corner ticks.
Everything inherits the card's ink, so it introduces no hue by construction
rather than by inspection.

**D6.4 — A project that is not `ready` is not a link.**
Rendering a draft / generating / failed card as a link and then landing the
user on an error page is worse than saying so on the card.

**D6.5 — Dates are formatted from UTC parts by hand.**
`toLocaleDateString` renders differently on the server and in the browser
whenever the two disagree about locale or time zone, which React reports as a
hydration mismatch — and `shoot.mjs` fails a viewport on any console error.

**D6.6 — No "New Project" card, disabled or otherwise.** As instructed. The
empty state names the CLI instead, which is the thing that actually works.

**D6.7 — `check:rwd` gained a gallery mode, because two of its checks cannot
apply to a page with no canvas.**
`scripts/shoot.mjs` was written for the viewer. Run unchanged against the
gallery, two of its six checks fail *structurally*, not because of anything the
gallery does:

- **scene colour** asserts the framebuffer carries real chroma, to catch a
  drained basemap. A gallery frame is monochrome by design — that check exists
  to fail exactly this picture.
- **attribution visible** hit-tests Cesium's credit container, which only
  exists where a Cesium viewer does.

Rather than let those stand red — a permanently failing run is one everyone
learns to ignore — `--gallery` skips those two and prints `n/a` with the
reason, and keeps the half the gallery is actually being asked to pass: the
computed-style monochrome audit over every element inside a floating panel, the
viewport-overflow and collision checks, and console errors. `check:rwd` now runs
both pages. The exemption is written down at the point of use, and the note says
that if a card ever renders map data the attribution exemption goes with it.

Result, all four viewports:

```
=== 1680x950 (gallery) ===   chrome elements: 23   PASS: chrome is monochrome
=== 1280x800 (gallery) ===   chrome elements: 23   PASS: chrome is monochrome
=== 834x1112 (gallery) ===   chrome elements: 23   PASS: chrome is monochrome
=== 390x844  (gallery) ===   chrome elements: 23   PASS: chrome is monochrome
ALL CHECKS PASSED
```

**D6.8 — `app/not-found.tsx` uses a plain `<a>`, not `next/link`, and that is a
workaround for a bundler bug.**
The first gallery audit failed all four viewports on one console error:
`SyntaxError: Unexpected token '**'`. It was not in any source file. Bisecting
found the emitted dev chunk `/_next/static/chunks/app/not-found.js` genuinely
malformed at its last line:

```
104  /******/ }
105  ]);*****/ }
```

— webpack's `/******/` comment framing, corrupted around a module id containing
`C%3A%5C%5CAero%20View`, i.e. **the space in this repository's own path**. The
chunk exists only because `app/not-found.tsx` imports `next/link`; the same
import in `app/page.tsx` and `app/p/[slug]/page.tsx` bundles cleanly. Swapping
it for an `<a href="/">` removes the chunk's client boundary and the error with
it, and a 404 page linking home wants a full navigation anyway rather than a
soft one. Worth knowing if this repository is ever moved to a path without a
space — the workaround would then be unnecessary, though it is harmless.
