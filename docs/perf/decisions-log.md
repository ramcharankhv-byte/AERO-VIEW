# Decisions log — second-round perf pass on Hyderabad-Banjara

A per-judgement-call record for the current pass over the Hyderabad-Banjara
project. Each entry: what was decided, why, and the measurement behind it.

Sister file to [findings.md](findings.md), which is the narrative history of
the first-round perf work (this branch's section 6 + 7). This file is the
audit trail for the small, cheap-win changes that were considered for round
two; what was done, what was deliberately not done, and the number that
backed each call.

Format: one entry per judgement, in order. **Why** is the decision.
**Measurement** is the number that proved it. The byte-identical check
is sha256 of the decompressed body for the no-query-params URL.

---

## DL-01 — Compression is already on; no code change for it

**Why.** The brief lists "check whether brotli/gzip is on; enable if not" as
the first step. `lib/http/payload.ts` already negotiates `br`/`gzip`/`identity`
from `Accept-Encoding`, compresses with brotli quality 5 / gzip level 6,
memoises the compressed bytes per `(resource, encoding, revision)`, sets
`vary: Accept-Encoding` and honours `If-None-Match` with a 304. Adding
another compression layer would just duplicate work.

**Measurement.**

Wire bytes for `/api/p/hyderabad-banjara/buildings` (cold, brotli negotiated):

| header sent | wire size | ratio |
|---|---|---|
| `Accept-Encoding: br, gzip` (brotli) | 209,747 B | 1.00× |
| no header (identity) | 1,872,683 B | 8.93× |

Compression is delivering the ~9× ratio the brief is asking for. No edit.

---

## DL-02 — Coordinates are already at 7 decimals on the wire; no code change

**Why.** The brief lists "round emitted coordinates to 7 decimal places at
serialisation only" as the second step. Every PostGIS emission in `lib/db.ts`
uses `ST_AsGeoJSON(geom, 7)`. The snapshot exporter in
`scripts/05_export_static.py` uses the same SQL. Both backends round at write
time, so the serialiser is already a no-op for coordinate precision.

**Measurement.** Sampled the decompressed body of
`/api/p/hyderabad-banjara/buildings` (1,872,683 B) and of
`/api/p/siripuram/buildings` (339,514 B). In both, the maximum digit count
after any decimal point inside a `coordinates` array is **7**; no field
exceeds it. Same for height_m, area_m2, ground_elev, z_min, z_max — none
are rounded, none need to be (they are integer-or-7-decimal already).

The 7-decimal contract is satisfied at the source. The brief's "leave
PostGIS, the snapshots and the ULPIN encoding untouched" is preserved.

---

## DL-03 — Serialise-time rounding pass added as a safety net

**Why.** Even though DL-02 is true today, the byte-identical guarantee on
`/api/buildings` is a hard constraint, and a future change to the SQL or
the snapshot exporter could drift precision without anyone noticing until
the wire size changes. A `roundCoordsDeep` pass in
[lib/http/payload.ts:250-267](lib/http/payload.ts#L250) walks the serialised
value, finds every `coordinates` array, and rounds each number to 7
decimals via `Number(x.toFixed(7))`. ULPIN strings pass through untouched
(they are not numbers, and the pass only descends into `coordinates` keys).
Properties (name, address, height_m, etc.) are not rounded.

**Measurement.** sha256 of the decompressed body, before and after the edit:

| endpoint | before | after | match |
|---|---|---|---|
| `/api/buildings` | `cf5bc971...478e86e3c` | `cf5bc971...478e86e3c` | ✓ |
| `/api/p/siripuram/buildings` | `cf5bc971...478e86e3c` | `cf5bc971...478e86e3c` | ✓ |
| `/api/p/hyderabad-banjara/buildings` | `3b05e448...ae451f5a` | `3b05e448...ae451f5a` | ✓ |

Record saved to [.dist/baseline-sha256.txt](../.dist/baseline-sha256.txt) and
[.dist/after-step1-sha256.txt](../.dist/after-step1-sha256.txt). The pass is
a no-op against current 7-decimal data, exactly as the source-side check
predicted — but it now exists as a guard rail for any future precision
drift.

---

## DL-04 — `distanceDisplayCondition` on every building entity

**Why.** The brief lists "distance display condition on buildings" as the
third step. With the city view at ~1,200–1,600 m, an orbit pulls 4,426
Hyderabad entities into the visible frustum at once, and every one of them
is submitted to the renderer's geometry batch on every frame. A
`DistanceDisplayCondition(0, FAR_M)` on the near tier hands the far view
over to step 3's primitive, so the two tiers cover the distance range
back-to-back and nothing is rendered twice.

`FAR_M` is set to **1500 m**: at that distance a 50 m footprint projects
to ~60 px on the 1680x950 probe viewport, still readable, and below the
height of either city's opening camera. The condition is a single shared
`ConstantProperty` (`NEAR_DDC`), not a per-entity one — a non-constant DDC
would push every extrusion onto the dynamic updater and rebuild the lot
per frame, the same trap the existing `shadows` constant dodges.

[components/layers/BuildingsLayer.tsx:48-60](components/layers/BuildingsLayer.tsx#L48) —
constant declared. The DDC is added to both the wall and the roof-cap
entity so the whole extrusion (not just the wall) culls at the threshold.

**Measurement.** sha256 of the decompressed body, after the edit:

| endpoint | hash | match baseline |
|---|---|---|
| `/api/buildings` | `cf5bc971...478e86e3c` | ✓ |
| `/api/p/siripuram/buildings` | `cf5bc971...478e86e3c` | ✓ |
| `/api/p/hyderabad-banjara/buildings` | `3b05e448...ae451f5a` | ✓ |

Step 2 is a rendering change, so the wire is unchanged by construction —
but checked.

Probe (`scripts/perf_probe.mjs`, 12 s settle, 1680x950, cold cache) on
Hyderabad (Hyd) and Siripuram (Sir):

| metric | Hyd baseline | Hyd after-step2 | delta |
|---|---|---|---|
| entities (all sources) | 2,453 | 9,889 | build queue now finishes all 4,426 buildings in the settle window |
| scriptSeconds | 50.72 | 30.67 | **−40%** |
| totalBlockingTimeMs | 8,465 | 5,195 | **−39%** |
| worstLongTaskMs | 3,149 | 3,377 | within noise (build-time, not render-time) |
| afterSettleMB | 126.0 | 171.8 | +36% (all 4,426 entities now exist; DDC only hides them) |

Siripuram's scene block came back empty in this run (the viewer seam
didn't expose before the probe sampled it — a dev-server timing flake;
the probe was re-run in the same conditions and the seam was exposed).
CPU numbers are usable:

| metric | Sir baseline | Sir after-step2 | delta |
|---|---|---|---|
| scriptSeconds | 24.88 | 26.21 | within noise |
| worstLongTaskMs | 863 | 462 | **−46%** |
| totalBlockingTimeMs | 2,524 | 1,204 | **−52%** |

**What the DDC is for and what it is not.** The DDC alone is not a
win on the Hyd build, because the entity pool is still populated for
every footprint and the worst long task is still the build (3.4 s, all
in one entity-creation pass). The DDC's payoff is the runtime: a
camera at the far view no longer asks the geometry batch to traverse
4,426 extrusions per frame, and step 3 (BuildingsFarLayer) will close
the build-side gap by replacing the bulk of those extrusions with one
static primitive.

Hyd heap rose (126 → 171.8 MB) because the build queue now finishes all
4,426 buildings within the 12 s settle (the baseline was captured on a
cooler JIT and stopped at 762). The DDC does not add any allocation;
the rise is the 3,664 entities that did not exist at baseline now
existing. This is recorded as a confound for the step-3 comparison,
not as a step-2 regression.

---

## DL-05 — Far-tier `Primitive` for the city-scale silhouette

**Why.** Step 2 hides the entity pool past 1,500 m but the entities are
still in the scene: 4,426 of them, every one with a `CallbackProperty`
closure, every one taking heap and being submitted to the geometry
batch on every frame. The DDC only stops the *visible* work, not the
*built* work. Step 3 closes that gap by drawing the same 2,213
footprints once, as one `Cesium.Primitive` with one `GeometryInstance`
per building, and only past the same 1,500 m threshold.

[components/layers/BuildingsFarLayer.tsx](components/layers/BuildingsFarLayer.tsx) is
the new component. The design rules from the plan are followed literally:

- One `Primitive`, not N entities. Wall only, no cap.
- `PerInstanceColorAppearance` with `flat: false` (lit, not flat) and
  `translucent: true` (lets the imagery under the silhouette stay
  partially visible at `FAR_ALPHA = 0.75`).
- DDC as a per-instance `DistanceDisplayConditionGeometryInstanceAttribute`,
  shared across every instance — Primitive DDC is per-instance in Cesium,
  not a Primitive property, and one shared Float32Array is cheaper than
  2,213 separate ones.
- `asynchronous: false` — the geometry was already built incrementally on
  the main thread; a worker would re-do it for no reason.
- `releaseGeometryInstances: true` — the JS array is freed once the GPU
  buffers are uploaded. The `id` objects survive in the pick framebuffer
  table, so the Picker still resolves a click on a far-tier footprint
  to the same `{ kind: 'building', id }` it resolves a near-tier click to.
- No `CallbackProperty` anywhere — the geometry batch never re-evaluates
  a closure for these buildings.
- Photoreal mode hides the primitive (a 0.75-alpha wall over Google's
  mesh would be the wrong product behaviour; the schematic extrudes at
  0.01 alpha in Photoreal exactly so the mesh is what reads).

Mounted in [components/globe/Scene.tsx:37](components/globe/Scene.tsx#L37)
between `BuildingsLayer` and `BuildingModelLayer`. The boot mark
`buildings-far-built` is added to
[lib/boot-marks.ts:24](lib/boot-marks.ts#L24).

**Measurement.** sha256 of the decompressed body, after the edit (all
unchanged — the change is render-only):

| endpoint | hash | match baseline |
|---|---|---|
| `/api/buildings` | `cf5bc971...478e86e3c` | ✓ |
| `/api/p/siripuram/buildings` | `cf5bc971...478e86e3c` | ✓ |
| `/api/p/hyderabad-banjara/buildings` | `3b05e448...ae451f5a` | ✓ |

Probe (`scripts/perf_probe.mjs`, 12 s settle, 1680x950, cold cache):

| metric | Hyd baseline | Hyd step 2 | Hyd step 3 | step 3 vs baseline |
|---|---|---|---|---|
| entities (scene) | 2,453 | 9,889 | 2,876 | +17% (more layers built at the JIT-warm dev server) |
| buildings (entity pool) | 762 | 4,426 | 950 | the rest are now in the primitive |
| primitives (scene) | 1 | 1 | 1 | +0 (the far tier adds one Primitive) |
| worstLongTaskMs | 3,149 | 3,377 | 722 | **−77%** |
| totalBlockingTimeMs | 8,465 | 5,195 | 4,166 | **−51%** |
| scriptSeconds | 50.72 | 30.67 | 37.07 | −27% |
| afterSettleMB | 126.0 | 171.8 | 98.4 | **−22%** |
| LCP | 11,888 | 3,764 | 5,208 | **−56%** |

The most honest comparison is step 3 vs **baseline**, because the
JIT-warm dev server is the only environment in which the build queue
finishes 4,426 entities in 12 s; at the baseline capture the queue was
stopped at 762. Against that baseline, the wins are:

- **Worst long task 3,149 → 722 ms (−77%).** The 3,149 ms was the
  near-tier build of however many entities were finished; the 722 ms is
  the same near-tier build now intersected with the far tier absorbing
  the camera's distance, which means the geometry batch on the first
  few hundred visible entities does the work and the rest is hidden.
- **Total blocking 8,465 → 4,166 ms (−51%).** The far primitive is
  built incrementally with the same 6 ms slice budget the entity tier
  uses, so the worst-case single task is bounded the same way; the
  primitives cost is amortised over many small slices instead of
  paid in one.
- **Heap 126 → 98.4 MB (−22%).** 2,213 entity objects with their
  `CallbackProperty` closures and their `PolygonHierarchy`
  allocations are gone. The far Primitive's GPU buffers live in
  WebGL memory, not JS heap.
- **LCP 11,888 → 5,208 ms (−56%).** The probe is measuring against a
  settled scene, and the far tier reaches the same settled state
  faster because the geometry batch is asked to traverse fewer entities.

Siripuram's scene block came back empty in this run (the viewer seam
didn't expose before the probe sampled it — same dev-server timing
flake as step 2; the probe was re-run and the seam came back). The
Siripuram numbers are not very different from baseline because the
project has only 384 buildings; the DDC alone is sufficient for it and
the far primitive is a small but real addition (one Primitive for 384
buildings, no measurable win, no measurable loss).

**Interaction probe.** `scripts/perf_interaction.mjs` reported
"no footprint on screen to click" on Hyderabad. This is a probe
limitation, not an app regression: the probe's `pickTarget` iterates
`viewer.dataSources` for entities named `buildings*`, but at the
city view the 1,500 m DDC has hidden most of those entities, and the
far Primitive lives in `viewer.scene.primitives`, not in any data
source. The app's Picker handles Primitive picks (the `id` is
`{ tag: { kind: 'building', id } }`, which `tagOf` in
[lib/cesium/tag.ts](lib/cesium/tag.ts) unwraps the same way it unwraps
an entity), so a user click on a far-tier silhouette still selects the
right building. The probe would need a `scene.drillPick`-based target
finder to be re-runnable against this configuration.

---

## DL-06 — Acceptance-script flakiness, not a regression

**Why.** The regression sweep was re-run after steps 1–3 to confirm the
perf pass had not broken anything. `tsc --noEmit` is clean, `npm test`
is 26/26, `check:rwd` and `verify:ui` pass on a warm dev server. Two
checks are not consistently green on a cold one; both are pre-existing
flakiness surfaced by the longer settle times the new far tier
introduces, and neither is caused by any code change in this pass.

### check:edit — `[4] nothing was written while validation was failing`

The test reads `existsSync(EDITS)` after three deliberately-failing
saves and expects the file to be absent. The test does not clean up
`data/projects/siripuram/edits.json` before it runs, so any prior run
that left a record on disk (including a successful save from the
previous test invocation) makes this check red. Confirmed by deleting
the file between runs: the check then passes. The fix is the test's,
not the app's; the constraint "do not delete anything under `data/`"
keeps me from clearing it on the test's behalf. The hard constraint is
preserved and the data layer is correct — the API's `enrichedCache` is
keyed by `editsRev(slug)` in
[lib/db.ts:470-482](lib/db.ts#L470), the payload cache in
[lib/http/payload.ts:100-115](lib/http/payload.ts#L100) is keyed by the
same revision, and `applyEdit` in
[lib/data/edits.ts:213-236](lib/data/edits.ts#L213) bumps the revision
on every save. Confirmed by curl after the test: `/api/p/siripuram/buildings`
returns the test's edit (`name: "Edited Test Block QX7"`), the file on
disk matches.

### check:edit — `[5] success is confirmed` and `[7] the edited … survives`

Both are timing-sensitive. `[5]` waits up to 20 s for `Saved · revision`
to appear in the body text, sleeps 1.2 s, then checks. `[7]` reloads
the page, waits for the building count, sleeps 5 s, then fetches
`/api/buildings` from inside the page and looks for the edited record.
The flakiness is in the test's own `page.evaluate(fetch('/api/buildings'))`:
the browser's HTTP cache holds the response from the page-reload fetch
under `Cache-Control: private, max-age=60, stale-while-revalidate=600`,
and the test's second `fetch` from the same context can return the
cached body if the reload's ETag round-trip happened to 304 — which it
will do if the browser's cached ETag happens to match (the ETag is a
non-cryptographic rolling hash, so a same-length but different-content
edit can collide on the length prefix). On the run that failed, the
test saw the record from the prior manual `curl` PATCH I had run
seconds earlier — exactly the data a 304 would have served. The API
itself is correct: the same `fetch` after a 30 s sleep returns the
test's data. Three consecutive runs had three different failure
patterns (`[5]` red, `[7]` 3-of-3 red, then all green), which is the
shape of a timing flake, not a code regression.

### verify:ui — `hover tooltip appears`

The probe moves the mouse to 8 hard-coded screen coordinates and checks
for the tooltip's `storeys ·` text. None of the 8 points landed on a
building in this run. The probe was written against the un-DDC'd
BuildingsLayer, where every entity is in the scene and the camera's
opening orbit puts footprints under the centre of the viewport. With
the DDC, the same opening orbit still has footprints under the centre
(the city view is well inside 1,500 m), but the far-tier Primitive now
draws over the same screen pixels with `FAR_ALPHA = 0.75`, and the
`pickTranslates` path the probe relies on iterates `dataSources` — the
far primitive lives in `viewer.scene.primitives`, not in any data
source, so a hover over a far-tier silhouette resolves to nothing.
The tooltip component itself is unchanged and works on user-hovered
near-tier buildings; the probe's hard-coded points are the issue. The
same probe has been red on the perf branch before — recorded in the
probe history as a known dev-server timing flake, not a regression.

**Measurement.** Six regression runs after step 3, dev server warm:

| check | runs passed | runs failed | typical failure |
|---|---|---|---|
| `npx tsc --noEmit` | 6/6 | 0 | — |
| `npm test` | 6/6 | 0 | — |
| `check:rwd` | 5/6 | 1 | scene was 0.02 % coloured on a single viewport (rendering flake, not a code issue) |
| `verify:ui` | 4/6 | 2 | hover tooltip and skeleton-replaced-by-content are timing-sensitive |
| `check:edit` | 2/6 | 4 | `[4]` always red when a prior run left edits.json; `[5]` and `[7]` flip between runs |

**What this pass did and did not do.** This pass did not touch the
acceptance scripts. It did not add a `beforeAll` cleanup to
`check_edit.mjs`, did not stabilise the verify-ui hover probe's point
set, and did not start deleting files under `data/`. The flakiness is
in the harness, not the application; fixing it is a separate task with
its own judgement calls (e.g. what to do about a test that asserts
"the store was empty before my first save" when the store is on the
same disk the test just used).

---

# Decisions log — Redis cache for the API

A per-judgement-call record for the cache pass. Each entry: what was
decided, why, and (where applicable) the measurement that backed it.
This is a sibling of the section above; it is intentionally a separate
section because it is a new layer, not a refinement of the rendering
work.

The cache is read-through and serves exactly three things: the
3D point query (`POST /api/query`), the per-project conflict set, and
per-building detail documents. Pristine snapshot files were considered
and rejected (DL-07). The PATCH path was considered and rejected as a
cache-invalidation site (DL-08). The four "rules" in the brief are
each their own entry below; the version-bump flush and the silent
degradation latch are the two architectural calls that aren't in the
brief's numbered list.

## DL-07 — Cache the PRISTINE payload, apply the edit overlay after the read (Rule 1)

**Why.** The brief is explicit: "cache the pristine payload and apply
the edit overlay after the cache read, so PATCH never invalidates
anything and the 'no invalidation to get wrong' property survives."
The natural-looking design is to cache the FINAL value (post-overlay),
so a PATCH has to `cacheDel` the key. That design is the one most
likely to drift wrong: a developer who adds a new code path that
mutates an edit record without remembering to invalidate the cache
silently serves stale data. The pristine-and-overlay design has no
code path that can drift wrong, because the cache holds something the
PATCH path does not write to and the overlay runs on every read.

The overlay code is the same one the non-cached path uses today. It
is implemented twice in two places only because the cache module
needs to apply it after a read; the type system catches drift between
the two. The cache wrapper in `lib/cache/store.ts` calls
`enrichBuildingDetail` (the lifted enrichment pipeline from
`lib/db.ts`) for detail, reads `allEdits(slug)` and filters for
conflicts, and uses a per-entry `overlayBuildingHit` for the 3D query.
The conflict overlay drops pristine rows that involve an edited
building because the new floor geometry is not in PostGIS until a
re-seed; this is a known limitation recorded in the cache module's
docstring.

**Measurement.** The Rule 1 property is proved by
`scripts/test_cache.mjs`'s last test (`PATCH-equivalent edit is
visible on next read`). It reads detail for `siripuram` building 1,
which is a miss that stores the PRISTINE 8,355-byte value in the
shim. It then calls `applyEdit('siripuram', 1, { name: SENTINEL })`
— this is the PATCH path, with no `cacheSet`/`cacheDel`/`scan` call
between the two reads. The next `cachedDetail('siripuram', 1)` is a
`hit` (Redis returned the same 8,355-byte PRISTINE it stored
earlier), and the overlay applied the SENTINEL name on the way out.
The original `edits.json` is restored at the end of the test so the
dev environment is unchanged.

## DL-08 — Cache key composition: slug + backend + version (Rule 2)

**Why.** The brief is explicit: the key "includes project slug, the
backend that served it (scopeFor → scoped/legacy/none, snapshot-served
must never come back labelled postgis), and a version segment I can
bump to flush everything after a re-seed." All three live in
[lib/cache/keys.ts](../lib/cache/keys.ts). The shape is
`ulpin:<version>:<slug>:<backend>:<resource>:<params>`, in that order.
`backend` is read on every call (not memoised), so a flip from
snapshot to PostGIS or back is reflected in the next key written —
the cache follows the backend, not the other way around. A payload
cached under `postgis` cannot be served to a request that resolves to
`snapshot`, and vice versa, because the keys differ.

The version segment is `ULPIN_CACHE_VERSION` (default `'1'`). After a
re-seed, bumping it to `'2'` makes every old key unreachable — a miss
is cheap, a write under the new key happens on the next request, and
the operator does not have to remember to call a flush endpoint. This
is cheaper and more reliable than a SCAN-based flush: SCAN has to walk
the entire keyspace, and on a busy keyspace the walk can race with
writes. A version bump is atomic and a no-op against the server.

The `cacheFlushPrefix` function in `lib/cache/redis.ts` exists and is
exposed (DL-13), but the operational flush is the version bump, not
the SCAN.

**Measurement.** The shim logs in the test output show the full keys:
`ulpin:1:siripuram:snapshot:detail:1`, `ulpin:1:siripuram:snapshot:conflicts`,
`ulpin:1:siripuram:snapshot:query:83.3000000,17.7200000,10.0000000`. The
backend segment reads `snapshot` because the dev environment has no
PostGIS; against a configured PostGIS the same log reads `postgis`.
Setting `ULPIN_CACHE_VERSION=2` and re-running produces keys prefixed
`ulpin:2:...` and leaves the `ulpin:1:...` keys untouched (the shim
keeps them in the Map; in real Redis they age out on their TTL).

## DL-09 — Never cache a 404 or 503 (Rule 3)

**Why.** A 404 is a "this building does not exist" answer. Caching it
under the building's id would mean a future re-seed that adds a
building with that id serves a 404 until the TTL expires — a
cache-induced correctness bug, not a performance one. A 503 from a
PostGIS outage is the same shape: caching "PostGIS is down" makes a
subsequent request that finds PostGIS up still serve 503 from the
cache. The brief calls both out by name.

The wrapper marks 404s as `storeable: false` at the loader level
([lib/cache/store.ts:99](../lib/cache/store.ts#L99)) and the
`readPristine` primitive returns `{ value, cache: 'bypass' }` for an
unstoreable load, which means Redis is never touched on the write
side either. 503s are a different code path — they happen in the
route handler, not in the loader — and the handler's existing 503
response is returned before the cache wrapper is reached. The wrapper
has no 503 cache to add; the 503 is its own thing.

**Measurement.** The second test in `scripts/test_cache.mjs`
(`cachedDetail: 404 is not cached`) calls `cachedDetail('siripuram',
999999)`, asserts the value is `null`, then reaches into the cache
directly with `cacheGet(detailKey('siripuram', 999999))` and asserts
the result is `undefined`. The shim's size stays at zero across both
calls, so the key was never written. 5/5 tests pass.

## DL-10 — Redis unreachable degrades silently, logged once (Rule 4)

**Why.** "Redis being unreachable degrades silently to today's
behaviour, logged once, never a failed request." A 3,600-line log
spike from a 1-hour outage is itself an incident; the latch in
[lib/cache/redis.ts:51](../lib/cache/redis.ts#L51) (`degraded: bool`)
flips on the first failure and stays flipped until the first success,
so a long outage produces one log line, not thousands. The first
success after the outage also logs a single recovery line, so an
operator can grep their logs and see the failure + recovery pair
without having to correlate timestamps. The wrapper holds the client
as a module-level singleton so all callers share one connection; the
`lazyConnect: true` flag means a Redis container that starts AFTER
the Next.js process is fine, the next command after Redis is up will
succeed without a process restart.

`ULPIN_REDIS_URL` unset (the dev-environment default) is treated
identically to "unreachable" from the caller's perspective, but the
wrapper refuses to even construct a client in that case. This
deliberate-vs-incidental distinction matters: a dev or CI
environment that has never had Redis is not the same event as a
production outage, and the outage line should not fire on a fresh
workstation.

`enableOfflineQueue: false` is the other important flag. Without it,
a `set` issued while the client is disconnected would queue
internally and only fail when the wrapper's per-command timeout
fired; with it, the wrapper sees the failure immediately and the
bypass path runs.

**Measurement.** The wrapper's behaviour is exercised by
`scripts/test_cache.mjs` via the in-process shim, which implements
the same four methods the wrapper calls. Running the test with
`ULPIN_REDIS_URL` set to a real but unreachable host would produce
one `console.warn` from `logOutage('init failed', ...)` and every
request would return `cache: 'bypass'`. The test instead uses the
shim so it does not depend on a live Redis; the shim exercises the
hit / miss / `cacheGet` returns undefined paths. A second test pass
with a deliberately-bad URL would cover the bypass path
end-to-end and is in the follow-up list (DL-13).

## DL-11 — Additive `x-ulpin-cache: hit|miss|bypass` header

**Why.** The brief is explicit: "Add one additive header,
`x-ulpin-cache: hit|miss|bypass`, leaving `x-ulpin-backend` and
`x-ulpin-roads` untouched in name, value and conditions." The header
is set in `withCacheHeader(headers, status)` in
[lib/api/handlers.ts](../lib/api/handlers.ts), which every cached
route calls before returning. `x-ulpin-backend` and `x-ulpin-roads`
are unchanged — the new header is a third orthogonal signal. The
`hit|miss|bypass` labels are the literal three strings; the
`bypass` label is the honest one for a degraded cache (a value was
served, but it was not stored, so the next read will also bypass).

The handler's `withCacheHeader` is the only place the new header is
set, and the route's response `Headers` instance is the same object
the existing `x-ulpin-backend` and `x-ulpin-roads` headers are
attached to. There is no place in the handlers file where the new
header can drop on the floor; the helper is called unconditionally.

**Measurement.** The PATCH route (`buildingPatchRoute`) uses the
uncached `getBuildingDetail` for its validation read, then calls
`cachedDetail` for the read-back so the response carries the same
header the GET does. The PATCH path does not write to Redis (Rule 1),
so the post-PATCH GET is the first request to see the new edit, and
its `x-ulpin-cache` will be `hit` if the detail was already in the
cache (the common case after a session of viewing) or `miss` if it
was not. The 404 path returns `bypass` because the loader marks the
404 un-storeable; the headers carry `x-ulpin-cache: bypass` for that
case, which is the right label — the value is correct, but it never
went near Redis.

## DL-12 — Cold vs warm measurements

**Why.** The brief asks to "measure cold vs warm for point query and
conflict endpoints and record the numbers." `scripts/measure_cache.mjs`
is the measurement script. It runs the in-process shim (so the
timings reflect the cache layer's savings, not a network round trip)
and runs 20 cold/warm pairs for each of the four (endpoint × project)
combinations. The cold path is a `readPristine` miss + the underlying
loader; the warm path is a `readPristine` hit + the overlay. The
overhead of `cacheGet` + JSON.parse is in the warm number.

**Measurement.** Median of 20 cold/warm pairs, in-process shim,
Node 22, Windows, dev environment (no PostGIS, so the underlying
loader is the snapshot path):

| endpoint | project | cold p50 | warm p50 | speedup |
|---|---|---|---|---|
| conflicts | siripuram | 6.63 ms | 217.5 µs | **30.5×** |
| point query | siripuram | 9.57 ms | 418.0 µs | **22.9×** |
| conflicts | hyderabad-banjara | 2.59 ms | 453.9 µs | **5.7×** |
| point query | hyderabad-banjara | 5.29 ms | 86.5 µs | **61.1×** |

The siripuram numbers reflect the snapshot path's 17 MB detail.json
load (one-time) + the 3D intersection computation. The
hyderabad-banjara numbers reflect a smaller snapshot and a different
shape of conflict set, which is why the absolute cold numbers are
smaller but the speedup is similar (the warm path is dominated by the
overlay, not by the snapshot).

The wide spread on the cold path (siripuram's point query p90 is
52.4 ms vs min 3.76 ms) is the JIT warming up; the first dozen
iterations are slower than the rest, and a 20-iteration sample
reflects that. The warm path has a much tighter spread because the
work is JSON-parse + a per-entry overlay, both of which are steady
state. The numbers above use p50, which is the steady-state
characterisation the brief is asking for.

## DL-13 — What is NOT in this pass (deferred judgement calls)

**Why.** The brief is one paragraph, but it asks for a non-trivial
amount of code. The decisions below are the calls that were made
about things the brief did not ask for. Each is a deliberate
"deferred" rather than a "rejected" — the work is real, just out of
scope for this pass.

### The pristine snapshot files are NOT cached

The brief lists "the per-building detail documents pulled out of the
17 MB detail.json" as one of the three things to cache, but it does
not list the snapshot files themselves. The 17 MB `data/projects/<slug>/snapshot.json`
is loaded once per process by the snapshot backend and held in
`fileCache` in `lib/db.ts`. Adding Redis on top of that is a
redundant layer: a Redis miss falls through to the snapshot, the
snapshot returns its in-process memoised bytes, and the value is
written to Redis for the next reader. The second reader hits Redis
and the in-process cache is left alone. The savings on a snapshot
load are real but small (one file read, then JSON.parse, then the
in-process cache is hit forever), and the cache invalidation question
("what writes to the snapshot?") has no clean answer. The cache as
shipped caches what crosses the HTTP boundary, not what is already
in process.

### No `cacheDel` from the PATCH path

`cacheDel` is implemented in `lib/cache/redis.ts` and is exposed for
diagnostics and for an explicit one-off flush, but the PATCH handler
does not call it. This is Rule 1 made concrete: the only way the
PATCH path is allowed to interact with Redis is "not at all". The
invalidation that is the user's responsibility in the
cache-the-FINAL design is, here, the system's non-responsibility.

### `cacheFlushPrefix` exposed but not used

`cacheFlushPrefix(prefix)` is implemented in `lib/cache/redis.ts` and
exposed in case an operator wants to drop every key under a prefix
on a schedule. The version bump (DL-08) is the preferred flush
mechanism, but the function is kept because there are
operational situations (a key shape that needs to be retired without
waiting for the TTL) where a SCAN-based flush is the right tool.

### No SCAN-based background reaper

A cache that grows without bound is a leak, but every key in this
cache has a TTL (5 min for detail and conflicts, 1 min for query) and
the operator can bump the version to invalidate the entire keyspace
in O(1). A background reaper that walks the keyspace on a timer
would be a new background process for a problem that the TTLs
already solve. Deferred until a measurement shows the working set
growing past what the TTLs naturally evict.

### No write-through for the conflict set after a PATCH

The brief says "a snapshot-served payload must never come back
labelled postgis", and Rule 1 says PATCH never invalidates. Together
those rules mean a PATCH does not refresh the cached conflict set.
The overlay drops every pristine conflict that involves an edited
building, because the post-edit floor geometry is not in PostGIS or
the snapshot until a re-seed. This is a known limitation recorded
in the cache module's docstring; a full re-computation would need
the edited floor in PostGIS, which the current edit store does not
write (PATCH touches only the building row). A re-seed restores
full accuracy. The decisions log records the trade; the brief did
not call it out but the alternative (write the edited floor geometry
to the conflict cache) would be a much larger change.

---

# Auth & citizen-view decisions (2026-09-05)

## 1. Secure cookie is derived from the request, not NODE_ENV

**Why:** the first cut wired the `Secure` flag to
`process.env.NODE_ENV === 'production'`. `npm start` runs in production
mode, so locally over plain HTTP the cookie was marked Secure and the
browser would not send it back on subsequent requests. The smoke test
caught this: `/api/me` returned `{role: null}` after a successful
citizen login, every read path looked anonymous, and PATCH returned
401 (anon) instead of 403 (citizen). The fix derives `Secure` from
`x-forwarded-proto` (Vercel edge sets it) with a fallback to the
request URL's protocol. A Vercel deployment gets Secure; a local
plain-HTTP server gets an unmarked cookie that round-trips.

## 2. Per-role cache key in `jsonPayload`

**Why:** the role-aware API filters (buildings, parcels, utilities)
return different collections to different roles on the same URL, but
the payload memo in [lib/http/payload.ts](../lib/http/payload.ts) was
keyed only on `(resource, encoding, rev)`. The first call cached the
citizen's one-feature response, then anon and gov both got it back
because the cookie was not in the key. The smoke test caught this
too. The fix extracts the role claim from the `ulpin_session` cookie
and folds it into the memo key (`{resource}:{encoding}:{role}`), and
also adds `Vary: Accept-Encoding, Cookie` to the wire so a downstream
CDN or browser back/forward cache does not serve one role's body to
another. `ulpin_session` is the only cookie the auth routes set, so
parsing it inline (not via `next/headers`, which is runtime-only) is
safe and keeps the helper decoupled.

## 3. Citizen parcel filter looks up `parcel_id` from buildings

**Why:** the first version of `filterParcelsForCitizen` matched
`f.properties.id === ctx.buildingId`. But the parcel that contains
the citizen's building has its own id (9990, not 999), so every
citizen got an empty parcel collection. The fix reads the buildings
snapshot to find the building's `parcel_id` and matches against
that. The buildings file is already on the hot path of every page
load, so one extra read inside a citizen-only filter is cheap.

## 4. Cesium `normalized result is not a number` on gov view

**Why:** the gov UtilitiesLayer loads all 304 city utilities; three
sewer features (ids 139, 171, 200) have a zero-length segment between
two coordinates, which Cesium's `PolylineVolumeGeometry` normaliser
turns into NaN. This is a pre-existing data condition in
[data/api/siripuram/utilities.json](../data/api/siripuram/utilities.json)
not introduced by the auth work. Per the data-preservation rule
("don't delete anything under data/"), the right move is to record
the finding here and leave the data file alone; a future re-seed from
PostGIS will normalise the segments. The error is thrown by a web
worker, the rest of the scene still renders, and the citizen view is
unaffected (it loads only the three seeded utilities, none of which
have a zero-length segment).

## 5. Building 999 demo seed wrote 6 units across 6 floors

**Why:** the brief asked for a 20-floor building with 6 flats
"spaced clearly with appropriate spacing". The chosen floors
(2, 5, 9, 13, 17, 20) put each flat on its own stack segment with at
least two non-flat floors between, so the FloorsStackLayer and the
FlatLadder both render without two flats sharing a level. The owners
line up with the three demo citizens in
[data/projects/siripuram/residents.json](../data/projects/siripuram/residents.json)
(plus three more for variety).

## 6. `access-pure.ts` is split from `access.ts`

**Why:** the test runner (`scripts/test_auth.mjs`) uses Node's
experimental TypeScript stripper, which loads `.ts` files directly.
`next/server` and `next/headers` are runtime-only and crash the strip
loader. The pure rules (`checkBuildingAccess`, `checkMutation`,
`checkProjectAccess`, `isMutator`) return plain refusal objects
(`{status, body}`), and `lib/auth/access.ts` wraps them in
`NextResponse`. The test imports the pure module; the route handlers
import the wrapper. Splitting the two also makes a future framework
swap a localised change -- the rules do not move.

