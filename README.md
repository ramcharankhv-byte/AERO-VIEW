# 3D ULPIN — Vertical Property Mapper

A three-dimensional cadastral viewer, one **project** per area of interest. The
demo project is **Siripuram, Visakhapatnam** (bbox
`83.3130,17.7180,83.3245,17.7280`); a second, **Banjara Hills Ward, Hyderabad**
(`78.4300,17.4100,78.4450,17.4250`), was generated from the same pipeline to
prove nothing about the first is hardcoded. See [Projects](#projects).

Land administration is normally drawn flat, but rights are not flat. This app
models the whole vertical stack — **parcel → building → floor → unit** — plus the
**underground utility corridors** that can legally encroach on a basement, and it
labels every entity with **where its data came from**.

That last part is the point of the system: in this area only **8% of buildings
carry a height in OpenStreetMap**, so almost every storey count on screen is an
inference. A viewer must never be left unsure which numbers were measured and
which were guessed.

![City view](docs/shots/1-city.png)

---

## Running it

```bash
npm install                # also copies Cesium assets into public/cesium
docker compose up -d       # PostGIS 16 + PostGIS 3.4 + SFCGAL
npm run db:schema          # only if the volume already existed
npm run seed               # fetch OSM -> estimate -> seed -> utilities -> roads -> export
npm run dev                # http://localhost:3000
```

`/` is the project gallery; each project's viewer is at `/p/<slug>`, e.g.
[`/p/siripuram`](http://localhost:3000/p/siripuram).

If your PostGIS volume predates multi-project support, migrate it rather than
re-seeding — the migration is additive and idempotent and never drops a table
or deletes a row:

```bash
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
  -f - < db/migrations/001_multi_project.sql
```

**The database is optional at runtime.** The route handlers try PostGIS first
and fall back to the committed snapshots in `data/api/<slug>/`, so
`npm run dev` alone renders the full app — gallery included. Every response
carries an `x-ulpin-backend: postgis|snapshot` header saying which path served
it, answered **per project**: with the database up and a project that exists
only as a snapshot, a global probe would have claimed `postgis` for a response
the snapshot served.

### Basemap imagery

The basemap is **Esri World Imagery** and needs no key. It keeps its own
colour: a treatment on the imagery layer pushes the exposure back and lifts
saturation, which over this AOI lands the ground on a deep green. The buildings
are never tinted with it -- they are neutral off-white, drawn at 45% so the
imagery under each block stays readable -- and the contrast between dark green
ground and neutral massing is the point of the scheme.

Both controls live in the Layers panel under the Basemap checkbox:

| Imagery | Notes |
|---|---|
| Esri World Imagery | Default. No token. |
| Esri Wayback (archive) | Historical mosaics. Needs `WAYBACK_RELEASE` (below). |
| Mapbox Satellite | Hidden unless `NEXT_PUBLIC_MAPBOX_TOKEN` is set. |
| Dark vector (no imagery) | CARTO `dark_all`. Non-photographic, and the fallback. |
| None | No layer at all; bare `#0d1219` globe. Underground mode, clean captures. |

**Tone** switches between `GIS dark` (default) and `Natural` (raw imagery, for
when a reviewer asks to see the source). Switching either control swaps layer 0
in place — the viewer is not rebuilt and the camera does not move.

If a provider fails to load, the app logs a warning and falls back to CARTO;
the StatusBar then shows the effective basemap marked `(fallback)`, so a
degraded map is never silent. The globe is never left untextured.

**Wayback releases** are global snapshots and there is no API for "the best one
over Siripuram". Pick one by hand from the
[Wayback app](https://livingatlas.arcgis.com/wayback) over the AOI and set
`WAYBACK_RELEASE` in `lib/cesium/imagery.ts`. Left `null` (the default), the
Wayback option resolves to current Esri imagery.

Attribution is a licence obligation — Esri, Maxar, CARTO and OSM credits render
bottom-left and must not be hidden. Esri's World Imagery service also carries
its own [terms of use](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)
for heavy or commercial use.

### Cesium ion token (optional)

A token affects **terrain only** — imagery does not use ion:

```
NEXT_PUBLIC_CESIUM_TOKEN=your_token_here
```

Without one the globe falls back to a flat ellipsoid and says so in a
dismissible notice. The basemap is unaffected, and the app is fully usable
either way.

---

## What is real, and what is not

This distinction is enforced in the data model, not just in the prose.

| Layer | Source | Status |
|---|---|---|
| Building footprints | OpenStreetMap (ODbL) | **Real** |
| Road centrelines | OpenStreetMap (ODbL) | **Real** |
| Storey counts, 8% | `building:levels` / `height` tags | **Real** (`osm_tag`) |
| Storey counts, 90% | area + building-tag heuristic | **Estimated** (`estimated`) |
| Storey counts, 4% | `data/surveyed_plans.json` | **Synthetic demo register** (`surveyed_plan` + `survey_synthetic`) |
| Ground elevation | no DEM supplied → 12.0 m default | **Placeholder** |
| Parcel boundaries | Voronoi plots around clustered footprints | **Derived, not surveyed** |
| Owners, tenure, encumbrances | generated placeholders | **Synthetic** |
| Utility alignments | offsets from road centrelines | **Representative, not as-built** |
| Street geometry + class | OpenStreetMap (ODbL) | **Real** |
| Street names, 10 of 131 | OSM `name` tag | **Real** (`name_source: osm_name`) |
| Street names, 121 of 131 | derived from position + nearest named street | **Derived** (`name_source: derived`) |
| Street IDs (`STR-###`), lengths | computed by `scripts/build_roads.mjs` | **Derived** |
| Building names, 59 of 384 | OSM `name` tag | **Real** (`name_source: osm_tag`) |
| Building names, 325 of 384 | `lib/mock/` name banks, seeded by building id | **Synthetic** (`generated`) |
| Building type, area, occupancy, owner, status | `lib/mock/`, derived from real floors/units | **Synthetic demo register** |
| Manual edits | typed into the viewer, stored in `data/edits.json` | **Local, no authority** |

`data/surveyed_plans.json` carries a `_synthetic: true` flag, and that flag is
threaded through the `building.survey_synthetic` column all the way to the
DetailPanel, which then renders the provenance badge as **“Surveyed plan
(demo)”**. Fabricated data is never allowed to borrow the authority of a real
survey.

`dsm_dem` provenance is implemented but yields **zero rows**, because no DSM/DEM
raster is supplied. Drop a `data/dem.tif` in and `02_heights.py` will use it.

### Streets

`data/raw_highways.geojson` has always been in the repository as an input to the
utility-corridor generator; it is now also a rendered, clickable layer.
`scripts/build_roads.mjs` merges the 265 OSM ways into 131 logical streets —
named ways grouped by name, unnamed ways by shared endpoints within a class —
computes a geodesic length for each, and freezes the result as
`data/api/roads.json` so the `STR-###` references are stable and reviewable in a
diff rather than recomputed per request.

The 121 streets OSM never named are **not** labelled "Road 1". Each is named
from its position relative to the nearest named street in the convention
Visakhapatnam actually uses — *Harbour Park Road 1st Cross*, *Chinna Waltair 1st
Main Road* — and carries `name_source: 'derived'` plus the anchor it was named
from. The panel says so, and points the user at `STR-###` as the reference that
claims nothing.

### The synthetic building register

`lib/mock/` attaches a register-style record to every building: a name, a
`BLD-####` reference, a type, a built-up area, an occupancy, an owner and a
status. It is deterministic — seeded from the building's integer id via
mulberry32, with a separate salt per field — so a building shows the same name
on every reload, in either backend, after a restart.

It never overwrites sourced data. Floors, height, ULPIN, parcel, footprint and
coordinates are passed through untouched; built-up area is *summed from the real
unit rows*; the building type is chosen only from the subtypes the real use type
and storey count permit. The 59 buildings that carry a real OSM name and the 6
with a real address keep them verbatim, marked `osm` in the panel while
generated values are marked `demo`.

Deleting `lib/mock/` and its one call site in `lib/db.ts` returns the
application to sourced-data-only, with no component changes: the fields are
merged in as `Partial<BuildingMock>`, so every consumer already handles absence.

### Manual edit

Nine attributes are editable — name, type, floors, height, built-up area,
occupancy, address, owner, status. **Coordinates and ULPIN are not**, and that
is enforced by the type rather than by a `disabled` attribute: they are absent
from `BuildingEdit`, so `PATCH /api/building/:id` answers `400` for them.

`lib/data/building-schema.ts` is imported by both the form and the route
handler, so a rule cannot pass in the browser and fail on the server, and a
server-only rejection renders in the same per-field slot as a local one. Saves
are pessimistic and round-trip to `data/edits.json` (gitignored; override the
location with `ULPIN_EDITS_PATH`). The edit overlay is applied as a pure
function over the pristine snapshot on each read, so the file cache never goes
stale and there is no invalidation to get wrong.

Editing storeys or height updates **one** building in the scene through a
`ConstantProperty` assignment rather than rebuilding all 768 entities; the
acceptance check asserts the entity count is unchanged across a save.

### The identifier

```
AP-VSP-3D26-<parcel4>-<bldg3>-<floor2>-<unit2>
        e.g. AP-VSP-3D26-0042-007-05-03
```

Right-truncated for coarser entities; floor codes are `00` ground, `01`–`99`
above, `B1`–`B9` basements.

> **This is an unofficial vertical extension of the 14-digit ULPIN
> (Bhu-Aadhaar). It is not an official government identifier**, is not issued by
> or registered with any revenue department, and carries no legal weight.

That sentence is rendered on the ULPIN card in the UI, not hidden in a tooltip.
`lib/ulpin.ts` and `db/02_functions.sql`'s `ulpin_fmt()` implement the same
encoding; their agreement is asserted in `lib/ulpin.test.ts`.

---

## Architecture

```
app/                     layout; / gallery; /p/[slug] viewer; api/p/[slug]/* (7 routes)
                         + 7 unscoped aliases and api/projects[/slug]
components/gallery/      ProjectCard, BboxSketch
components/globe/        CesiumRoot (viewer, imagery, terrain), CameraDirector, Picker, Scene
components/layers/       Parcels, Roads, Buildings, FloorStack, Units, Utilities, Conflict
components/ui/           TopBar, LayerPanel, ActionBar, FloorLadder, ElevationRuler,
                         DetailPanel, ParcelInset, NavDock, StatusBar, Legend,
                         ConflictBanner, UlpinCard, Provenance, IonNotice
lib/                     projects.ts, ulpin.ts, store.ts, db.ts, types.ts,
                         api/handlers.ts, data/*, mock/*, cesium/*
db/                      01_schema.sql, 02_functions.sql   (run by initdb)
                         migrations/001_multi_project.sql  (for an existing volume)
scripts/                 seed.py orchestrator, 01-05 pipeline, project.py,
                         build_geometry.sql, utilities.sql, build_roads.mjs,
                         verify_ui.mjs, check_roads/check_edit/shoot
data/api/<slug>/         per-project snapshots, served when the DB is down
data/api/projects.json   the committed registry, so the gallery renders offline
data/projects/<slug>/    per-project inputs, the Overpass cache, and edits.json
```

**Everything is scoped by project.** One project is one AOI: a bbox, the
revenue codes its ULPINs are minted under, a status, and the cadastral stack
built inside it. `parcel`, `building` and `utility` carry a `project_id`;
`floor` and `unit` deliberately do not — they inherit one through `building`,
and a duplicated column would be a second answer to the same question that
nothing enforces agreement between.

Four rules the code actually obeys (and `grep` can confirm):

1. **One store, few writers.** The Zustand view store holds
   `{mode, activeBuildingId, isolatedFloor, selectedUnitId, layers, explodeT,
   theme, underground, …}`. Only `Picker` and the UI controls write to it.
   Layer components read it and render.
2. **All camera motion lives in `CameraDirector`.** No `flyTo`, `zoomTo` or
   `lookAt` exists anywhere else. (`CesiumRoot` performs a single `setView` to
   frame the **project's bbox** at construction — the scene's initial pose, not
   a transition. It takes the bbox as an argument; there is no AOI constant
   left in the camera path.)
3. **Colours are defined once**, in `lib/cesium/materials.ts`.
4. **Every DetailPanel entity shows a provenance line.**

### Notable implementation decisions

**Metric geometry is built in SQL, not Python.** Python 3.14 has patchy wheels
for `shapely`/`rasterio`, and PostGIS+SFCGAL was already a hard dependency. The
Python scripts do fetch and attribute estimation only — stdlib plus an optional
`rasterio` — while extrusion, unit subdivision, utility offsetting and conflict
detection are SQL. Construction happens in **EPSG:32644** (UTM 44N) and is
transformed back to **4326**; `ST_Transform` leaves Z alone, so stored solids are
lon/lat degrees + height in metres, exactly what Cesium consumes.

**`ST_MakeSolid` is not optional.** `ST_3DIntersects` treats a
`POLYHEDRALSURFACE` as a *shell*, so a point strictly inside a prism does not
intersect it, and a corridor lying wholly within a basement envelope — the worst
kind of encroachment — would go unreported. Both the point query and the
conflict pass promote shells to solids first.

**One animation driver per layer.** `BuildingsLayer` builds its 384 entities
once; hover, fade and hide are `CallbackProperty` closures reading a single
mutable ref, eased by one `requestAnimationFrame` loop rather than 384 tweens.

**Terrain reconciliation.** The DB stores `ground_elev` per spec (12.0 m without
a DEM). Siripuram is hilly, so the viewer samples real terrain under every
building once at load and shifts each stack by the difference. The schema is
untouched; only rendering is reconciled.

**An isolated floor shows the level and its flats together.** The level is drawn
as a thin base plate at its base Z plus a translucent shell over its full height,
and every unit on it stands on that plate as its own solid box — co-visible and
co-pickable, not a drill-down level below.

Two things keep the flats visible, and both are load-bearing. The shell is drawn
at `FLOOR_VIEW.SHELL_ALPHA`, because at full slab thickness a level's volume
*encloses* its own units and wins the depth test. And `Picker` drill-picks and
takes the topmost **unit** if the ray found one, because otherwise the shell in
front of the flats wins the pick ray instead. The plate or shell resolves as the
floor only when no unit is under the cursor — the level's own space, i.e.
corridors and common areas.

Each flat is inset `FLOOR_VIEW.UNIT_INSET_M` from its stored footprint and lifted
`FLOOR_VIEW.UNIT_LIFT_M` off the plate, at render time only. Units are a grid
subdivision, so neighbours share wall lines in the DB; drawn as stored they
z-fight, and in section they merge into one slab. The DB geometry, the API and
the stored ULPINs are untouched. Every distance, alpha and threshold behind this
lives in `FLOOR_VIEW` in `lib/cesium/materials.ts`.

**Slice cuts the rings, not the framebuffer.** Cesium exposes
`ClippingPlaneCollection` on a `Globe`, a `Model` and a `Cesium3DTileset` only —
an entity's `PolygonGraphics` draws through a `Primitive`, which has no
`clippingPlanes` property at all, and every sliceable surface here (plates,
shells, unit volumes, slabs) is entity geometry. So `lib/geo.ts` defines the
half-plane once and `lib/cesium/section.ts` clips the rings against it on the
CPU, feeding the result back through the same `CallbackProperty` mechanism the
rest of the scene animates with. The clip re-runs when the plane moves, not per
frame. Slicing a whole building collapses every level to its plate for the same
reason the isolated floor does, and the architectural model steps aside because
its opaque walls would hide the cut. Slice and Explode are mutually exclusive,
enforced in the store rather than in the two controls.

---

## API

Every cadastre endpoint is scoped by project. The seven unscoped paths still
exist as **thin aliases onto the demo project** — the acceptance scripts and
every bookmark predate projects — and share their handler body with the scoped
route, so alias and scoped response are byte-identical by construction rather
than by review.

| Endpoint | Alias | Returns |
|---|---|---|
| `GET /api/p/:slug/buildings` | `/api/buildings` | GeoJSON FeatureCollection of every footprint |
| `GET /api/p/:slug/building/:id` | `/api/building/:id` | building + floors + units, nested |
| `PATCH /api/p/:slug/building/:id` | `/api/building/:id` | record a manual edit; returns the re-read document. `400` for a non-editable field (coordinates, ULPIN), `422` for a validation failure |
| `POST /api/p/:slug/query {lon,lat,z}` | `/api/query` | every entity whose 3D volume contains the point, ordered parcel < building < floor < unit |
| `GET /api/p/:slug/utilities` | `/api/utilities` | utility centrelines with depth/radius/authority |
| `GET /api/p/:slug/conflicts` | `/api/conflicts` | flagged `ST_3DIntersects` violations |
| `GET /api/p/:slug/parcels` | `/api/parcels` | surface parcels (beyond the brief; the parcels layer and inset need it) |
| `GET /api/p/:slug/roads` | `/api/roads` | merged street centrelines with names, classes and lengths |
| `GET /api/projects` | — | every project, with its stats |
| `GET /api/projects/:slug` | — | one project |

Two failures are answered differently, and the gallery renders them as
different states:

| | |
|---|---|
| `404` | nothing knows this slug — not the registry, not PostGIS, and there is no `data/api/<slug>/` |
| `503` | the project is real, but it has no exported snapshot and the database is not answering |

Telling a user their project does not exist when their docker is merely stopped
is the wrong answer, so the two are never collapsed.

```console
$ curl -s -X POST localhost:3000/api/query -H 'Content-Type: application/json' \
    -d '{"lon":83.3157,"lat":17.7268,"z":16.7}'

parcel    AP-VSP-3D26-0001            K. Venkata Rao
building  AP-VSP-3D26-0001-001        Water Resourse Block   z 12.00..28.00
floor     AP-VSP-3D26-0001-001-01     Level 1                z 15.20..18.40
unit      AP-VSP-3D26-0001-001-01-01  B01                    z 15.35..18.05
```

---

## Projects

One project is one area of interest. The gallery at `/` lists them; each opens
at `/p/<slug>`.

| | |
|---|---|
| `slug` | URL segment and directory name, `^[a-z0-9][a-z0-9-]{0,63}$` |
| `bbox` | west, south, east, north — what the camera frames and what Overpass is asked for |
| `state_code`, `district_code`, `scheme_code` | the ULPIN prefix, e.g. `TS-HYD-3D26` |
| `status` | `draft` / `generating` / `ready` / `failed`; only `ready` is openable |
| `stats` | entity counts, denormalised so a card needs neither seven `COUNT(*)`s nor a database |

### Generating one

```bash
npm run seed -- --slug=hyderabad-banjara --name="Banjara Hills Ward" \
  --bbox=78.4300,17.4100,78.4450,17.4250 --state=TS --district=HYD
```

It creates or updates the project row, caches the raw Overpass response to
`data/projects/<slug>/osm.json`, runs estimate → seed → utilities → streets →
export scoped to that project, writes `data/api/<slug>/`, and fills in
`projects.stats`. `npm run seed` with **no** arguments is the demo project,
with the same bbox, the same codes and the same file paths it has always used —
and no network at all, because its OSM extract is committed.

Rejected at entry, before the first Overpass request, with a non-zero exit: a
bbox over **4 km²**, an aspect ratio worse than **3:1**, or malformed
coordinates. The first two are Overpass etiquette as much as ours — it is a
free shared service — and the third is almost always two transposed numbers.

### Identifiers are per project, and that is the point

Parcel **numbering** restarts at 0001 in every project; it is the state and
district prefix that keeps the identifiers distinct, exactly as the real
identifier means it to. `AP-VSP-3D26-0001` and `TS-HYD-3D26-0001` are different
parcels in different districts.

Row **ids** are a different thing and stay globally unique, because they are
what the foreign keys and `/api/p/<slug>/building/:id` address rows by.
`scripts/build_geometry.sql` computes both: a per-project ordinal for the
ULPIN, and that ordinal plus an offset for the primary key. For the first
project seeded the offset is zero, which is why none of siripuram's identifiers
or ids moved when this was introduced.

### What a second project does not share

Snapshots (`data/api/<slug>/`), manual edits
(`data/projects/<slug>/edits.json` — the store is keyed by building id, and
building ids are only unique within a project), the OSM extract, and the
optional DEM and survey register, which live in the project's own work
directory.

What it *does* still share, and should be read as synthetic accordingly: the
owner-organisation pool and the utility authorities in
`scripts/utilities.sql` name bodies that operate in Visakhapatnam. On another
AOI those are placeholders in the same sense every owner name has always been —
see the truth table above — but they are placeholders that borrow a real
body's name in the wrong city, which is worth knowing before showing a second
project to anyone.

---

## The deliberate conflict

`scripts/utilities.sql` routes one sewer straight through a building's basement
and marks it `unauthorised alignment`, so the 3D check has something real to
find. `ST_3DIntersects` reports **12** conflicts in total — the planted one plus
11 genuine incidental encroachments where a service corridor clips a basement.
Underground mode pulses them red and names the planted one first.

![Underground](docs/shots/6-underground.png)

---

## Verifying

```bash
npm test            # ULPIN round-trip + SQL-parity assertions
npm run verify:ui   # drives a real Chrome through all five view modes
npm run check:roads # street picking, tolerance, deselect, building precedence
npm run check:edit  # read-only guarantees, validation, save, persistence
npm run check:rwd   # four viewports x two pages: layout, collisions, colour audit
npm run build:roads # regenerate data/api/siripuram/roads.json from the OSM extract
```

The browser-driven checks target `/p/siripuram` by default, since `/` is the
gallery now. `ULPIN_URL` overrides it; their API paths are unchanged, because
they drive the unscoped aliases.

`verify:ui` walks city → building → explode → floor → unit → underground,
asserts the DOM at each step, checks the disabled controls really are disabled,
fails on any console error, and writes screenshots to `docs/shots/`.

`check:rwd` renders each viewport and audits it twice, because the colour rule
has two halves. The **chrome** must stay monochrome: every element inside a
floating panel is read back from its computed styles and reported if it carries
any hue but the sanctioned alert red — which a class-name grep cannot fool, and
which still works now that the panels float over a colour scene, where a
rectangle of pixels no longer belongs to the chrome alone. The **scene** must
stay in colour: the composited frame is measured for chroma and fails below 3%,
which is what catches an imagery treatment or a texture pass that has quietly
drained it. It also verifies that no two panels overlap, that none runs
off-screen, and that Cesium's attribution container — a licence obligation — is
never covered.

`check:rwd` runs twice: once over a project's viewer, once over the gallery
(`--gallery`). Two of its six checks cannot apply to a page with no canvas —
the framebuffer chroma test exists to catch a drained basemap, and a gallery
frame is monochrome by design; the attribution hit-test needs Cesium's credit
container, which only exists where a Cesium viewer does. Both are skipped there
with an `n/a` line stating why, rather than left permanently red. The
attribution exemption goes away the moment a card renders map data.

Both suites were run against **PostGIS and the snapshot backend**, and the
`POST /api/query` stack is byte-identical between them.

### Current state

- **siripuram** — 384 buildings · 325 parcels · 131 streets · 1,810 floors ·
  6,438 units · 301 utility runs · 12 conflicts
- **hyderabad-banjara** — 2,213 buildings · 1,309 parcels · 350 streets ·
  8,119 floors · 31,807 units · 1,214 utility runs · 80 conflicts
- `tsc --noEmit` clean, 26/26 unit tests, 46/46 UI checks, 26/26 street checks,
  31/31 edit checks, responsive checks green at 1680/1280/834/390 px on both
  the viewer and the gallery
- The chrome audit reports **0 off-palette elements** at every viewport, and the
  scene audit a frame that is roughly 45% coloured: dark green ground under
  neutral off-white massing, with Cesium's attribution logo — which may not be
  restyled — excluded from the count

### Not implemented

**Measurements, Share and Split view** are rendered visibly disabled rather than
hidden, so their absence is explicit rather than implied.

**Editing a storey count does not regenerate floor and unit records.** Those are
cadastral child rows; fabricating them would be a far larger invention than a
name. The panel says so whenever the two disagree.

**Streets are snapshot-only.** `db/01_schema.sql` has no road table, so unlike
buildings and parcels there is no PostGIS path for `lib/db.ts` to prefer;
`GET /api/roads` sends `x-ulpin-roads: derived` to say so on the wire.

---

## Data licence

Building footprints and road centrelines are © OpenStreetMap contributors,
licensed **ODbL**. Everything derived from them here inherits that licence.
