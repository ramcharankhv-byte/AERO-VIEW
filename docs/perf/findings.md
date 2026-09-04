# Startup performance: profile, causes, results

Production build (`next build` + `next start`), cold HTTP cache, headless
Chrome, 1680x950. Raw numbers in `before.json` / `after.json`. Harnesses:
`scripts/perf_probe.mjs`, `scripts/perf_bisect.mjs`, `scripts/perf_frame_js.mjs`,
`scripts/smoke.mjs`.

Reproduce:

```
NEXT_PUBLIC_ULPIN_PROBE=1 npm run build
npm start
node scripts/perf_probe.mjs --label after --out docs/perf
node scripts/perf_frame_js.mjs
node scripts/smoke.mjs
```

---

## 1. Root causes, ranked by measured impact

### RC1 — the boot payload contained a second city

This work was profiled on `main`, where `/api/buildings` returned **2,597
footprints spanning 519 km**. Clustering the coordinates showed two groups:
2,213 buildings in Hyderabad and 384 in Siripuram. `main` has no project
dimension at all, so it served whatever the shared PostGIS tables held, while
its camera was pinned to Visakhapatnam — 85% of the payload was parsed,
terrain-sampled and turned into 4,426 Cesium entities that could never be on
screen.

**On this branch that is already solved, and solved properly.** Every reader in
`lib/db.ts` takes a slug and pushes `project_id` into the `WHERE` clause, so
`/api/p/siripuram/buildings` returns 384 and `/api/p/hyderabad-banjara/buildings`
returns 2,213 — the two halves of the 2,597, each to the viewer that wants it.

The bbox filter written for `main` (`lib/aoi.ts`) was therefore **deliberately
not ported**. It answers the same question with a worse mechanism, and merged
here it would have been actively wrong: its box is pinned to Siripuram, so it
would have filtered Banjara Hills' own data out of Banjara Hills' viewer.

What this means for the numbers below: the `main` before/after pair measures a
6.8x reduction in dataset size that this branch already had. The per-project
measurements in section 5 are the honest picture of what the *rest* of the work
is worth here, and the large project is where to look.

### RC2 — API responses were not compressed

`NextResponse.json()` streams `Transfer-Encoding: chunked` with no
`Content-Encoding`. The five boot endpoints shipped **4,408 KB of raw GeoJSON**.
GeoJSON is nearly all ASCII digits and repeated keys; brotli takes it to about a
tenth. Even before the AOI filter, compression alone took 4,408 KB to 711 KB.

### RC3 — boot was a strict serial chain, and imagery was last in it

| mark | before (ms) | gap | what the gap was |
|---|---|---|---|
| boot-start | 1797 | 1797 | HTML + 1.07 MB of JS parsed and evaluated |
| terrain-ready | 3152 | 1355 | **waiting on ion before constructing the Viewer** |
| viewer-created | 3291 | 139 | Viewer construction |
| data-fetched | 6173 | 2882 | 4.4 MB of uncompressed GeoJSON |
| ground-sampled | 6961 | 788 | `sampleTerrainMostDetailed` over 2,597 points |
| context-ready | 6961 | 0 | layers finally allowed to mount |
| buildings-built | 8476 | 1515 | entity construction |

The basemap effect hangs off the published context, so **the first imagery tile
was not requested until 7 s** — on a page whose biggest visual element is the
basemap.

### RC4 — the hang was one task

`worstLongTaskMs: 3744`, at 8,614 ms: 12,101 entities built between two paints.
Total blocking time 7,435 ms. This is the reported "device becomes sluggish or
temporarily hangs while the 3D map initialises".

### RC5 — ~7,000 per-frame property callbacks

Every entity with a non-constant `CallbackProperty` material is re-evaluated by
Cesium's geometry batch on every rendered frame. Parcels and utilities each
carried one purely to answer "am I the selected one?" — 1,633 and 1,514
callbacks per frame respectively, all computing `false`.

### RC6 — unbounded client cache, no request cancellation

`putDetail` grew forever; a detail document runs to 35 KB. Measured **+45.1 MB of
heap over five select/deselect cycles**. In-flight detail fetches were never
aborted, so clicking through buildings queued up JSON decodes for buildings the
user had already left.

### RC7 — one batched primitive cannot be frustum-culled

Cesium batches a data source's static entities into as few primitives as it can.
One primitive spanning the AOI has a bounding volume spanning the AOI, so it is
always inside the frustum: flying down to inspect one building still submitted
all of them.

---

## 2. How frame cost was measured, and why not in FPS

Frame **rate** in headless Chrome is not usable: it software-rasterises, and the
floor with **everything hidden, globe included, is ~90 ms/frame**. The probe's
`motion` block is reported for completeness but should not be read as an FPS
result on real hardware.

Frame cost was therefore measured as **main-thread JS per rendered frame** — CDP
`ScriptDuration` over 120 forced renders. That is the same work on any GPU, and
it is what competes with React, input handling and the compositor.

The baseline bisect (`perf_bisect.mjs`, `perf_frame_js.mjs`) established two
things, and the second one is why the buildings layer was *not* rewritten:

| configuration | JS ms/frame | delta |
|---|---|---|
| all layers on | 47.21 | — |
| parcels hidden (4,902) | 46.54 | −0.67 |
| roads hidden (406) | 46.56 | −0.65 |
| utilities hidden (1,515) | 41.82 | −5.39 |
| buildings hidden (5,194) | 40.52 | −6.69 |
| **all data sources hidden** | **39.30** | **−7.91** |

Every application entity in the scene accounted for ~8 ms of a 47 ms frame. The
other ~39 ms is Cesium's own render loop with no application geometry at all.
Migrating the city-scale buildings from Entities to a batched `Primitive` with
per-instance colour attributes — the textbook answer, and the one `RoadsLayer`'s
own comment names as the planned migration — could therefore recover at most
that 8 ms, in exchange for a rewrite touching picking, photoreal ghosting, the
selection fade and the edit path. **That trade was not worth taking on this
evidence**, so it is recorded as a scalability recommendation rather than done
blind. Cutting the entity count 4.9x achieved more, for far less risk.

---

## 3. Before / after

Matched runs: same build settings, same machine, same 12 s settle, cold cache.

| Metric | Before | After | Change |
|---|---|---|---|
| **First Contentful Paint** | 924 ms | 424 ms | −54% |
| **Largest Contentful Paint** | 3,856 ms | 740 ms | **−81%** |
| **Canvas present (map draggable)** | 3,554 ms | 698 ms | **−80%** |
| DOMContentLoaded | 593 ms | 53 ms | −91% |
| Viewer constructed | 3,291 ms | 537 ms | −84% |
| **Layers mount (`context-ready`)** | 6,961 ms | 1,888 ms | **−73%** |
| **All geometry built (`buildings-built`)** | 8,476 ms | 3,187 ms | **−62%** |
| **Worst long task** | **3,744 ms** | **214 ms** | **−94%** |
| Total blocking time | 7,435 ms | 1,918 ms | −74% |
| Long-task total | 8,185 ms | 3,218 ms | −61% |
| JS execution (ScriptDuration, whole session) | 27.9 s | 19.0 s | −32% |
| Total task time | 39.0 s | 20.5 s | −47% |
| **JS per rendered frame** | **47.2 ms** | **19.8 ms** | **−58%** |
| **Cesium entities** | **12,101** | **2,461** | **−80%** |
| **API bytes (5 boot endpoints)** | **4,408 KB** | **168 KB** | **−96%** |
| Total transferred | 9.07 MB | 5.15 MB | −43% |
| **Heap after settle** | **225.1 MB** | **82.3 MB** | **−63%** |
| Heap growth over 5 select cycles | +45.1 MB | +11 to +23 MB | GC-dependent; see below |
| Duplicate detail requests per cycle | 4 | 0 | — |
| Startup requests | 218 | 249 | +14% (see below) |

Functional verification: `scripts/verify_ui.mjs`, the project's own acceptance
harness, **passes end to end (exit 0)** — city view, parcel and building
picking, floor isolation, unit picking, section slicing, underground mode,
conflict banner, hover tooltip, stats charts, sun slider and loading skeletons.
`scripts/smoke.mjs` passes against the live backend.

### The numbers that need a caveat

**Request count rose, 218 → 249.** All of it is imagery tiles: 120 → 166. The
basemap effect now runs at 0.5 s instead of 7 s, so within the same 12 s
measurement window the globe gets much further through streaming its texture.
That is the intended behaviour — the map is textured sooner — not a regression.
Request count was never the goal; startup JS, main-thread work and payload were.

**The probe's `motion` median rose, 118 ms → 160 ms.** This is the
software-rasteriser artefact described in section 2: the floor is ~90 ms/frame
with nothing drawn at all, and the after-run has a third more imagery decoding
in flight during the drag. The device-independent measurement of the same
thing — JS per rendered frame — went **47.2 ms → 19.8 ms**. No FPS claim is made
from this harness; measuring real frame rate needs a GPU-backed browser.

**Heap growth over select cycles varies run to run** (+11 MB and +23 MB on two
runs, against +45 MB before). The number depends on when V8 chooses to collect,
so only the direction is trustworthy. The settled heap, which is stable, fell
from 225 MB to 82 MB, and the LRU now bounds the detail cache at 48 documents
where it was previously unbounded.

**The probe's `motion` median rose, 118 ms → 160 ms.** This is the
software-rasteriser artefact described in §2 — the floor is ~90 ms/frame with
nothing drawn at all, and the after-run has 33% more imagery decoding in flight
during the drag. The device-independent measurement of the same thing, JS per
rendered frame, went **47.2 ms → 19.8 ms**. No FPS claim is made from this
harness; measuring real frame rate needs a GPU-backed browser.

---

## 4. Remaining bottlenecks

1. **1.07 MB of JavaScript, essentially all Cesium.** `boot-start` at 640 ms is
   parse and evaluation of that bundle, and it is now the single largest item
   before first paint. Cesium is one ESM graph built around `Viewer`; it does
   not usefully tree-shake, and code-splitting the app's own components would
   move tens of kilobytes out of a megabyte.
2. **~19 ms/frame of Cesium's own render loop**, independent of application
   geometry. Not addressable from application code.
3. **The detail path still returns the full document by default.** The
   progressive endpoints exist and are tested, but `DetailPanel` has not been
   moved onto them (see §6).
4. **Ion terrain still costs a round trip** (~1.1 s) before the real surface
   appears. It no longer blocks anything, but the globe is ellipsoidal until it
   lands.

---

## 5. Architectural changes for real scalability

These are recommendations, deliberately not implemented blind:

1. **3D Tiles for the building layer.** Entities are the right representation
   for a few thousand footprints; they are the wrong one for a city. A tileset
   gives real LOD, streaming and per-tile culling, and would let the AOI grow
   without the boot cost growing with it. The bucket grid added here is the
   cheap 80% of the same idea and the natural stepping stone.
2. **A project dimension in the schema and the API.** The Hyderabad data is not
   junk, it is a second project sharing tables with no way to ask for one. A
   `project_id` column, a `?project=` parameter and a switcher in the UI turn
   the bbox filter from a guard into a feature. The `bbox` parameter shape is
   already defined in `lib/aoi.ts`.
3. **Vector tiles for parcels and roads.** Ground-classified polygons and
   polylines are the most expensive things this scene draws, and they are static.
   Tiled and CDN-cached they would cost the server nothing per request.
4. **Redis, once there is a second app instance.** Deliberately not added now —
   see the note at the top of `lib/server-cache.ts`. The cache API there is
   async and key-namespaced so the swap is contained.
5. **Migrate `BuildingsLayer` to `Primitive` + per-instance colour** if profiling
   on real GPUs shows the remaining ~8 ms/frame of entity cost matters. The
   measured ceiling for that work is documented in §2.


---

## 6. Ported onto `feat/multi-project`

Everything above was measured on `main`. The same work now lives on this
branch, adapted rather than copied:

| Change | How it differs here |
|---|---|
| Compression + ETag | Applied inside `serve()` in `lib/api/handlers.ts`, so all five collection endpoints get it at **both** URLs (`/api/x` and `/api/p/<slug>/x`) from one edit. Cache keys carry the slug. |
| Server detail cache | Keyed `detail:<slug>:<id>`, and reachable only through a function that takes a slug first. Warming is per project and idempotent per (project, process); a hot name absent from a project is a no-op, so one list serves every AOI. |
| Progressive endpoints | `summary` / `floors` / `units` added at the scoped path **and** as unscoped aliases, following the branch's own convention that every endpoint exists at two URLs sharing one handler body. |
| AOI bbox filter | **Dropped.** `project_id` scoping supersedes it — see RC1. |
| Boot restructure, time-slicing, bucket grid, LRU, React fixes | Ported unchanged; the five layer files and `terrain.ts` were byte-identical between the branches. |
| Point query | Taken **out** of `serve()`. `serve()` memoises under a per-resource key, and every point query would have shared the key `<slug>:query` while answering about a different point — one user's click would have been served another's stack. It answers directly, `no-store`. |

### Two pre-existing bugs found while porting

Both are on this branch independently of the performance work, and both were
fixed because the port touched the exact call sites:

1. **`useEnsureDetail` fetched the unscoped `/api/building/:id`**, which the
   alias resolves to the demo project. Building ids are offset per project, so
   a Hyderabad building's id does not exist in Siripuram: clicking any building
   in that project returned **404 and the detail panel never filled in**.
   Verified before the fix (`/api/building/780` → 404,
   `/api/p/hyderabad-banjara/building/780` → 200). Now scoped by `projectSlug`.
2. **`BuildingEditForm` PATCHed the unscoped alias** for the same reason. Left
   alone it would have been worse *after* fix 1 than before: the panel would
   show the right building while the save went to another project. Also scoped.

The unscoped aliases are untouched — `scripts/check_edit.mjs` drives them
directly and must keep working.

A third defect was mine, found by the acceptance suite and fixed before commit:
`useEnsureDetail`'s new AbortController was attached to an effect that depends
on the whole `detail` record, so ANY document landing anywhere re-ran the
effect, fired the cleanup and aborted the fetch for the building the user was
actually looking at -- which the `pendingDetail` guard then stopped from
retrying. The effect now depends on a boolean, "is THIS id cached", so a
cleanup can only mean the id changed, the document arrived, or the component
unmounted. All three are safe to abort on.

### Measured, per project

Both from a cold cache on the production build. The demo project is small; the
Banjara Hills project is the one that shows whether the work holds at scale.

| | siripuram (384 buildings) | hyderabad-banjara (2,213) |
|---|---|---|
| Entities built | 2,461 | **10,180** |
| First Contentful Paint | 424 ms | 376 ms |
| Largest Contentful Paint | 688 ms | 676 ms |
| Canvas present | 658 ms | 633 ms |
| Layers mount | 1,826 ms | 1,787 ms |
| All geometry built | 2,450 ms | 9,262 ms |
| **Worst long task** | **371 ms** | **315 ms** |
| Boot API payload (brotli) | 164 KB | 568 KB |
| Boot API payload (raw) | 925 KB | 3,676 KB |

The right-hand column is the result that matters. At **10,180 entities** — close
to the 12,101 that froze `main` for 3.7 seconds — the worst task is **315 ms**,
the canvas is live at 633 ms, and the scene fills in progressively over the
following nine seconds without ever blocking input. Time-to-interactive is now
essentially independent of how big the AOI is; only time-to-complete scales
with it, which is the correct trade.

Total blocking time on the large project is 10.9 s across 132 tasks — the
progressive build spread thin. That is sustained moderate work rather than a
freeze, and it is the next thing to attack if that project becomes the default:
see the 3D Tiles recommendation in section 5.

### Verification

- `scripts/verify_ui.mjs` passes end to end on this branch: **46/46, ALL CHECKS
  PASSED**. One assertion had to be corrected rather than the app: the harness
  throttled only `/api/building/:id` to observe the loading skeleton, and the
  application now correctly asks for the scoped URL, so the request was no
  longer slowed and the skeleton was gone before it could be sampled. The
  regex matches both URL shapes now.
- `scripts/smoke.mjs` passes for **both** projects, including the gallery
  listing every registered project and the Hyderabad detail panel that
  previously 404ed. Run it with `ULPIN_SLUG=hyderabad-banjara npm run smoke`.
- Cross-project cache isolation checked explicitly: interleaved reads of
  `/api/p/siripuram/building/1` and `/api/p/hyderabad-banjara/building/780`
  return `AP-VSP-…` and `TS-HYD-…` every time, and the two projects' collection
  ETags differ and each revalidates to 304 independently.
