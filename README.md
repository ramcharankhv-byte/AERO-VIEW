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

<iframe src="https://drive.google.com/file/d/1hGSyG8ZU2ROfpFQoKXblmGps_eTcB1dl/preview" width="960" height="540" allow="autoplay"></iframe>

_Demo of the 3D ULPIN viewer_

---

## Running it

```bash
npm install                # also copies Cesium assets into public/cesium
docker compose up -d       # PostGIS 16 + PostGIS 3.4 + SFCGAL
npm run db:schema          # only if the volume already existed
npm run seed               # fetch -> clip DEM -> estimate -> hazard -> seed -> utilities -> roads -> export
npm run dev                # http://localhost:3000
```

`npm run seed` is stdlib Python. The one stage with third-party needs is the
DEM clip and sample (`scripts/dem.py`: `gdalwarp`, `rasterio` or
`gdallocationinfo`, `pyproj`); without them it says so and every building keeps
the 12.0 m placeholder. To seed with real ground elevation, create the seed-only
toolchain once and run the pipeline from it:

```bash
# user-space, no admin: https://mamba.readthedocs.io/en/latest/installation/micromamba-installation.html
micromamba create -y -p ./.gdal-env -c conda-forge python=3.12 gdal rasterio pyproj
npm run seed:geo           # = .gdal-env/python scripts/seed.py, same arguments as seed
```

`/` is the project gallery; each project's viewer is at `/p/<slug>`, e.g.
[`/p/siripuram`](http://localhost:3000/p/siripuram).

If your PostGIS volume predates multi-project support, migrate it rather than
re-seeding — the migration is additive and idempotent and never drops a table
or deletes a row:

```bash
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
  -f - < db/migrations/001_multi_project.sql
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
  -f - < db/migrations/002_cartodem_bhuvan.sql
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1   -f - < db/migrations/003_hazard_exposure.sql
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1   -f - < db/migrations/004_utility_categories.sql
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1   -f - < db/migrations/005_survey_parcel.sql
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1   -f - < db/migrations/006_volumetric_units.sql
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1   -f - < db/migrations/007_ladm.sql
# 007 adds the ISO 19152 tables but not the function that fills them: that
# lives with the other stored functions, and re-applying the file is a no-op
# for every function that already existed.
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1   -f - < db/02_functions.sql
docker exec -i ulpin-postgis psql -U ulpin -d ulpin   -c "SELECT * FROM ladm_backfill(1);"
```

Migration 002 adds the ground-elevation provenance columns and the Bhuvan
overlay block; the pipeline writes them, so it is required before re-seeding.

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
in place — the viewer is not rebuilt, the camera does not move, and any context
overlay above layer 0 stays where it is.

### Context overlays (ISRO Bhuvan)

A project may carry a `bhuvan_layers` block naming NRSC Bhuvan WMS layers
(`https://bhuvan-vec2.nrsc.gov.in/bhuvan/ows`, WMS 1.3.0, EPSG:4326). The
Layers panel then shows a **Context (ISRO)** group with one toggle per layer the
project defines — for Siripuram: **Land use (SISDP 1:10k)**, **Flood hazard
zones**, **Cyclone hazard zones**. They are drawn as `ImageryLayer`s above the
basemap (LULC at 30% opacity, the AOIs being uniformly built-up; hazard zones at
50%), off by default, credited `© NRSC/ISRO Bhuvan` in Cesium's attribution
container, and they survive a basemap change. Bhuvan is never a basemap: its
vector server carries no imagery, so Esri stays the default.

**The hazard overlays are graded locally, because the national ones cannot be.**
Bhuvan's flood and cyclone layers return a *single polygon* over an AOI 1.2 km
across: switched on alone they wash the whole ward one flat colour and say
nothing about which streets are worse than which. So `scripts/hazard.py`
derives a local exposure index for every building from the project's own
CartoDEM surface and the coastline in the same tile, and the viewer paints it
on the ground in four graded classes with a key beside the toggle.

| weight | Flood exposure | Cyclone exposure |
|---|---|---|
| highest | ground height above sea level (0.45) | distance to the shoreline (0.50) |
| middle | depth below the local surroundings within 250 m (0.40) | how exposed the ground is above its surroundings (0.30) |
| lowest | distance to the shoreline (0.15) | building height, as wind load (0.20) |

Class boundaries are fixed scores, not quantiles, so a class means the same
thing in every project and seeding a new AOI cannot re-grade an existing one.
Over Siripuram this gives 127 low / 132 moderate / 99 high / 27 severe for
flood and 136 / 134 / 104 / 11 for cyclone, and the two disagree about 309 of
the 385 buildings — the low sheltered ground that floods is not the exposed
high ground the wind hits. Every value carries `derived` provenance in the
DetailPanel, and both keys say in words that this is computed here and is not
an NRSC rating. The Bhuvan zone stays underneath at 25% as the national
classification it is.

With the LULC overlay on, the Legend shows Bhuvan's own `GetLegendGraphic`.
Selecting a building issues one `GetFeatureInfo` at the footprint centroid
(lat,lon axis order, as WMS 1.3.0 + EPSG:4326 requires) and the DetailPanel
adds `LULC: <class> — SISDP 1:10k (Bhuvan)`; the lookup is cached per building
and never delays the rest of the panel. The server sends
`Access-Control-Allow-Origin: *`, so there is no proxy route: tiles and lookups
go to Bhuvan directly.

If a provider fails to load, the app logs a warning and falls back to CARTO;
the StatusBar then shows the effective basemap marked `(fallback)`, so a
degraded map is never silent. The globe is never left untextured.

**Wayback releases** are global snapshots and there is no API for "the best one
over Siripuram". Pick one by hand from the
[Wayback app](https://livingatlas.arcgis.com/wayback) over the AOI and set
`WAYBACK_RELEASE` in `lib/cesium/imagery.ts`. Left `null` (the default), the
Wayback option resolves to current Esri imagery.

Attribution is a licence obligation — Esri, Maxar, CARTO, OSM and (with an
overlay on) NRSC/ISRO Bhuvan credits render bottom-left and must not be hidden. Esri's World Imagery service also carries
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
| Ground elevation, Siripuram | CartoDEM v3 1 arc-sec, NRSC/ISRO, sampled at each footprint centroid, EGM96 orthometric | **Real** (`dsm_dem`, `elev_source: cartodem_v3`) |
| Ground elevation, Banjara Hills | no DEM tile supplied → 12.0 m default | **Placeholder** (`placeholder`) |
| LULC class (overlay + DetailPanel row) | NRSC SISDP 1:10,000 (2016–19), Bhuvan WMS | **Real**, external, context only |
| Flood / cyclone hazard zones | NRSC national-scale, Bhuvan WMS | **Real**, external, one class over the whole AOI |
| Flood / cyclone exposure grading | `scripts/hazard.py` over the CartoDEM surface + coastline | **Derived**, relative within the AOI, not an NRSC rating |
| Parcel boundaries | Voronoi plots around clustered footprints | **Derived, not surveyed** |
| Owners, tenure, encumbrances | generated placeholders | **Synthetic** |
| Section 22A restricted lands | `data/projects/<slug>/section-22a.json` | **Demonstration register, not a government list** (`register.authoritative: false`) |
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

**Ground elevation is real for Siripuram.** `data/projects/siripuram/dem_raw.tif`
is the NRSC CartoDEM v3 tile `N17 E083` (1 arc-second; gitignored at 51 MB).
`scripts/dem.py` clips it to the bbox with `gdalwarp` into the committed
`data/projects/siripuram/dem.tif` (49 × 43 cells, 8 KB, nodata −32768) and
`02_heights.py` samples it at every footprint centroid. The tile carries no
vertical-datum key and no NRSC sidecar, but it reads −5 … −54 m over dry land,
which is only possible as a height above the WGS84 ellipsoid, so every sample is
converted to EGM96 orthometric height with `pyproj` and the project records
`elev_datum: msl_egm96`. Siripuram's ground now runs 19.6 – 82.6 m MSL. A
building over a nodata cell would keep 12.0 m with `ground_source: placeholder`;
none does. The registry (`data/api/projects.json`) says which applies per
project in `elev_source`, and the DetailPanel says it per building. Banjara
Hills has no tile and stays an honest placeholder.

The viewer still reconciles every stack against the terrain it draws
(`lib/cesium/terrain.ts`) and logs, once per load, the mean and largest
difference between the stored `ground_elev` and Cesium World Terrain. Expect a
mean near −65 m for Siripuram even now: World Terrain is ellipsoidal and the
stored values are MSL, and that constant offset is exactly what the
reconciliation removes.

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

## ISO 19152 (LADM)

The schema has described itself as *LADM-inspired* since its second line, and
the containment hierarchy really does follow LADM: parcel → building → floor →
unit. What it did not have was the half that hierarchy exists to serve. Rights
and holders were flat text on the rows they described — `parcel.owner`,
`unit.owner`, `unit.tenure`, `unit.encumbrance` — so the only join between Flat
901, its parking bay and its share of the ground was that all three carried the
same owner **string**. That is not a join: two owners with the same name merge
into one, and one owner spelled two ways splits into two.

Migration 007 adds the four core classes, plus the membership table that
carries the share:

| Table | ISO class | What it is |
|---|---|---|
| `la_party` | `LA_Party` | a holder, an association, a municipal body, a utility operator, a bank |
| `la_ba_unit` | `LA_BAUnit` | the administrative record one entity holds |
| `la_ba_unit_member` | — | which spatial units are in a bundle, **and on what share** |
| `la_spatial_unit` | `LA_SpatialUnit` | which existing row is a spatial unit |
| `la_rrr` | `LA_RRR` | a right, restriction or responsibility against a bundle |

Selecting Flat 901 and opening the **Legal** tab answers as one record: the
volume, Parking Slot P-213 as an appurtenance, and 1/80 of the plot beneath it,
with the rights, the holder and the tax demand attached.

**The registry stores no geometry.** `la_spatial_unit` records *which* row is a
spatial unit and points at it; `la_spatial_unit_v` joins the shape back on.
Migration 006 settled this argument for unit kinds and it holds harder here — a
duplicated `PolyhedralSurfaceZ` that drifts from its original is a cadastre
disagreeing with itself about where a property is.

**Both datums, always.** Every `z` here is orthometric (EGM96). EPSG:4979 —
what a LADM consumer expects of a 3D CRS — is ellipsoidal, and the two are 72 m
apart at Visakhapatnam. Quoting one and labelling it the other would be an
error the size of a twenty-storey building that nothing downstream could
detect, so every payload carries both against their own CRS URNs. Where a
project records no geoid separation the ellipsoidal pair is **omitted**:
converting by zero would assert that the geoid and the ellipsoid coincide.

**Rights are redacted like everything else.** `LA_Party` and `LA_RRR` are
precisely what `filterDetailForCaller` strips from the building document, so
`filterLadmForCaller` narrows this one server-side — gov and the volume's own
holder see everything; anyone else sees the spatial unit and the easements over
it, and is told why. The easements survive deliberately: they name operators,
never people, and `/api/utilities` already serves the same runs to anyone.

**The flat register stays a file.** Mortgages, tax demands and the parking
allocation live in `data/projects/<slug>/flat-register.json`, are projected
into `LA_RRR` on read, and are marked on screen as coming from the register
rather than the cadastre. Absorbing them into PostGIS would create exactly the
split-brain `lib/db.ts` describes. The bay allocation is there for the same
reason it is not a column on the bay: a bay carries no owner because it is not
separately titled, and who may park in P-213 is a term of the *flat's* title.

**Air rights are derived, not seeded.** Flyover decks and pillars have no row
in either backend — they are file-sourced specs so they render with the
database down — so `su_type = 'air_rights'` units are minted from the spec at
request time and marked `provenance: 'derived'`.

`ladm_backfill(project_id)` fills the tables from what already exists and is
safe to re-run; re-running it is how the projection is refreshed after a
re-seed. It invents nothing: every party is a name already on a row, every
right a tenure or encumbrance string already stored. Where the register is
silent — a staircase with no holder — the projection is silent too.

Identifiers: `su_id` is the 3D ULPIN wherever one exists. The two kinds that
have none take a namespaced form under the same revenue prefix —
`AP-VSP-3D26-UTL-00042` for a corridor, `AP-VSP-3D26-AIR-TTF-P07` for an
air-rights volume. `ladm_utility_su_id()` and `suIdForUtility()` mint the
identical string; `lib/ladm.test.ts` holds them to each other, because SQL's
`lpad()` truncates where `padStart` only pads up and the two disagreed once
already.

---

## Architecture

```
app/                     layout; / gallery; /p/[slug] viewer; api/p/[slug]/* (7 routes)
                         + 7 unscoped aliases and api/projects[/slug]
components/gallery/      ProjectCard, BboxSketch
components/globe/        CesiumRoot (viewer, imagery, terrain), CameraDirector, Picker, Scene
components/layers/       BhuvanOverlay (ISRO WMS), HazardRisk (derived grading),
                         Parcels, Roads, Buildings, FloorStack,
                         Units, Utilities, Conflict
components/ui/           TopBar, LayerPanel, ActionBar, FloorLadder, ElevationRuler,
                         DetailPanel, ParcelInset, NavDock, StatusBar, Legend,
                         ConflictBanner, UlpinCard, Provenance, IonNotice
lib/                     projects.ts, ulpin.ts, store.ts, db.ts, types.ts, bhuvan.ts,
                         hazard.ts, ladm.ts (ISO 19152 classes + mapping),
                         api/handlers.ts, data/*, mock/*, cesium/*, deed/*
db/                      01_schema.sql, 02_functions.sql   (run by initdb)
                         02_functions.sql also holds ladm_backfill(),
                         ladm_plan_geom(), ladm_utility_su_id()
                         migrations/001_multi_project.sql  (for an existing volume)
                         migrations/002_cartodem_bhuvan.sql, 003_hazard_exposure.sql,
                         004_utility_categories.sql, 005_survey_parcel.sql,
                         006_volumetric_units.sql, 007_ladm.sql (ISO 19152)
scripts/                 seed.py orchestrator, 01-05 pipeline, dem.py, hazard.py, project.py,
                         build_geometry.sql, utilities.sql, build_roads.mjs,
                         verify_ui.mjs, check_roads/check_edit/shoot
data/api/<slug>/         per-project snapshots, served when the DB is down
data/api/projects.json   the committed registry, so the gallery renders offline
data/projects/<slug>/    per-project inputs, the Overpass cache, edits.json,
                         dem_raw.tif (ignored) and its committed clip dem.tif
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
Python scripts do fetch and attribute estimation only — stdlib, plus the
optional geo toolchain that `scripts/dem.py` alone uses — while extrusion, unit
subdivision, utility offsetting and conflict detection are SQL. Construction happens in **EPSG:32644** (UTM 44N) and is
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

**Terrain reconciliation.** The DB stores `ground_elev` from the project's DEM
when there is one (Siripuram: CartoDEM, MSL) and 12.0 m otherwise. Cesium World
Terrain is a different surface in a different datum, so the viewer samples it
under every building once at load and shifts each stack by the difference, and
logs the mean and maximum of that difference. Only rendering is reconciled.

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

**An isolated basement is lifted into the light.** Below grade the level sits
inside the terrain, so isolating B2 used to fly the camera under an opaque
globe. Now the isolated basement's plate, shell and contents are drawn
`FLOOR_VIEW.BASEMENT_LIFT_CLEAR_M` above the ground, in a cooler grey, with a
ring at true ground level, a dashed tie-line down to the stored position and a
caption quoting the stored depth (`B2 · 8.0 m below ground`). The lift is
computed once, in `lib/cesium/basement-lift.ts`, and `FloorStackLayer`,
`UnitsLayer` and `CameraDirector` all take the same number from it. Nothing
stored moves; the depth on screen and in the panel is from the record.

**A structural core carries no identity.** The lift shaft, the staircase, the
lobby, the drive aisles and the plant room are building fabric held in common,
not spatial units anyone holds. The demo seed writes them without a ULPIN,
areas or tenure; PostGIS still needs one (`unit.ulpin` is `NOT NULL`), so
`stripCoreIdentity` in `lib/auth/access-pure.ts` removes it on the way out for
every caller and both backends serve the same document. Selecting a core
segment draws ONE full-height bar from B2 to the roof in place of the
per-level boxes (the rows stay per level: explode and section are per level),
and the card describes the shaft with no ULPIN, no certificate and no Legal tab.

**Every flat carries one parking bay.** B1 and B2 hold three banks of 2.4 m
bays with two drive aisles, minus the two centre bays the cores pass through:
40 per level, 80 in all, one per flat. The allocation is a register fact
(`parking_ulpin` on the flat's entry), printed on the flat's card, bundled into
its LA_BAUnit, and exported on the certificate as an *Appurtenant parking*
block with the bay's own identifier. The seed refuses to write a register in
which the bay and flat counts differ.

**A citizen sees their building, with details of their flat alone.** The
building document served to a citizen holds every floor (none with its
ULPIN), their flat with its register entry, and the bay that entry allocates.
Every other flat and bay keeps its shape and its kind and nothing else -- no
door number, no label, no identifier, no register -- so a neighbour's volume
is an anonymous mass the pick falls through. Structural cores keep their
name, because nobody is behind a lift shaft. The building keeps its name and
massing and loses its identifier and owner; the parcel is dropped, and the
buildings and parcels collections are stripped the same way, so the map shows
their building and no other. The chrome follows the data: the level ladder
works (their own floor is marked), and the layer, underground, stats, search,
2D GIS and slice controls are absent.

---

## Section 22A restricted lands

Section 22A of the Registration Act 1908, as amended in Andhra Pradesh and
Telangana, lets the state publish a list of properties a sub-registrar may not
register a transaction on: government land, assigned land, endowment and wakf
property, Bhoodan land, ceiling-surplus land, and land under a court order.

The **22A** control in the dock draws that list on the map — a crimson hatch
inside a heavy boundary, with a `22A` label once you zoom past 900 m — and
clicking a marked plot opens the register entry: status, survey number, parcel
ULPIN, category and clause, extent in acres, village / mandal / district, the
issuing authority and its memo number.

Three things about it are load-bearing.

**It marks land; it does not draw land.** Every boundary is the cadastral
parcel's own ring, borrowed by reference and never reshaped
(`lib/section22a/resolve.ts`). A register that publishes its own boundary is the
exception, and then that boundary wins over ours — a department is the authority
on where its own land is. `npm run check:22a` compares the drawn rings against
`/api/p/:slug/survey-parcels` vertex for vertex.

**The register that ships here is a demonstration register.** It is not the
Registration & Stamps prohibited-property list, no plot in it is asserted to be
legally restricted, and every surface says so: the card, the legend, the API
body and the `x-ulpin-22a-source` header. `register.authoritative` is the one
field that governs the wording, and `lib/section22a.test.ts` fails if a shipped
file ever claims otherwise.

**Connecting the real list is one module.** `lib/section22a/source.ts` defines
`Section22ASource`; the MVP implementation reads
`data/projects/<slug>/section-22a.json`. Write one against a government feed,
return it from `section22aSourceFor()`, and nothing in `components/` changes —
the card's wording flips on its own, because it reads `authoritative`.

The register is a file rather than a table on purpose. It is read on **both** the
PostGIS and the snapshot path, so the two cannot disagree about it — the same
reasoning `flatRegister()` in `lib/db.ts` already follows, and it is also the
correct home on the merits: a 22A listing is a registration-department record
about what may not be *done* with a plot, not a survey record about what the plot
*is*.

Entries the register holds but this project cannot place — a plot outside the
AOI — are counted and reported in the legend as "listed, but not located in this
area", never silently dropped and never drawn at a guessed position.

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
| `GET /api/p/:slug/section-22a` | `/api/section-22a` | Section 22A restricted lands, as GeoJSON, plus a `register` block naming the source. `x-ulpin-22a-source` names it in a header too |
| `GET /api/projects` | — | every project, with its stats |
| `GET /api/projects/:slug` | — | one project |
| `GET /api/p/:slug/ladm/spatial-unit/:suId` | — | the ISO 19152 document for one spatial unit |
| `GET /api/v1/ladm/parcel/:ulpin3d` | — | the same document, with the project resolved from the identifier |

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
    -d '{"lon":83.3245,"lat":17.72808,"z":64.9}'

parcel    AP-VSP-3D26-0001            P. Sailaja
building  AP-VSP-3D26-0001-001        Water Resourse Block   z 60.16..76.16
floor     AP-VSP-3D26-0001-001-01     Level 1                z 63.36..66.56
unit      AP-VSP-3D26-0001-001-01-02  B02                    z 63.51..66.21
```

The `z` values are metres above mean sea level (EGM96): the building's ground
is the CartoDEM sample at its centroid, 60.16 m, and Level 1 starts one storey
above it. Before the DEM every stack in the AOI started at the 12.0 m
placeholder.

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
| `elev_source`, `elev_datum` | `cartodem_v3` + `msl_egm96` when a DEM was sampled, `placeholder` + null otherwise |
| `bhuvan_layers` | optional `{ lulc, flood, cyclone }` Bhuvan WMS layer names; absent = no Context (ISRO) group |

### Generating one

```bash
npm run seed -- --slug=hyderabad-banjara --name="Banjara Hills Ward" \
  --bbox=78.4300,17.4100,78.4450,17.4250 --state=TS --district=HYD
```

It creates or updates the project row, caches the raw Overpass response to
`data/projects/<slug>/osm.json`, runs clip DEM → estimate → seed → utilities →
streets → export scoped to that project, writes `data/api/<slug>/`, and fills
in `projects.stats`. Drop an NRSC CartoDEM tile at
`data/projects/<slug>/dem_raw.tif` and run it through `npm run seed:geo` to get
real ground elevation; otherwise the project is an honest placeholder. `npm run seed` with **no** arguments is the demo project,
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
npm test            # ULPIN round-trip + SQL-parity assertions, datum, topology
npm run verify:ui   # drives a real Chrome through all five view modes
npm run check:volumetric  # interior volumes, retail plan, clash engine, LADM, certificates
npm run check:roads # street picking, tolerance, deselect, building precedence
npm run check:edit  # read-only guarantees, validation, save, persistence
npm run check:rwd   # four viewports x two pages: layout, collisions, colour audit
npm run build:roads # regenerate data/api/siripuram/roads.json from the OSM extract
```

The browser-driven checks target `/p/siripuram` by default, since `/` is the
gallery now. `ULPIN_URL` overrides it; their API paths are unchanged, because
they drive the unscoped aliases.

Both pages require a session, and the harness has no login step, so hand it a
signed cookie minted with the server's own `SESSION_SECRET` (read from
`.env.local`):

```bash
export ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs)
npm run verify:ui && npm run check:rwd
```

`verify:ui` also needs the `window.__ulpinViewer` seam, which a production
build only carries when built with `NEXT_PUBLIC_ULPIN_PROBE=1`; `npm run dev`
has it unconditionally.

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
`POST /api/query` stack is byte-identical between them. So is the ISO 19152
document: `data/api/<slug>/ladm.json` is a dump of the same query
`lib/db.ts` runs per request, and the two responses were diffed field for field
with the database stopped.

`check:volumetric` covers the LADM half end to end — the redaction an anonymous
caller gets, the bundle a government caller gets, both vertical datums and the
geoid separation between them, the easements resolving under a surface plot,
the four ISO class names actually appearing in the Legal tab, and the
certificate carrying all four. It needs a gov cookie for the half that is not
public:

```bash
export ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs)
npm run check:volumetric
```

### Current state

- **siripuram** — 384 buildings · 325 parcels · 131 streets · 1,810 floors ·
  6,438 units · 301 utility runs · 12 conflicts
- **hyderabad-banjara** — 2,213 buildings · 1,309 parcels · 350 streets ·
  8,119 floors · 31,807 units · 1,214 utility runs · 80 conflicts
- **ISO 19152** — 41,574 spatial units · 3,233 BA units · 3,286 rights ·
  117 parties, backfilled across both projects from what the cadastre already
  held
- `tsc --noEmit` clean, 108/108 unit tests, 46/46 UI checks, 26/26 street checks,
  31/31 edit checks, responsive checks green at 1680/1280/834/390 px on both
  the viewer and the gallery
- The chrome audit reports **0 off-palette elements** at every viewport, and the
  scene audit a frame that is roughly 45% coloured: dark green ground under
  neutral off-white massing, with Cesium's attribution logo — which may not be
  restyled — excluded from the count



## Data licence

Building footprints and road centrelines are © OpenStreetMap contributors,
licensed **ODbL**. Everything derived from them here inherits that licence.

Ground elevation for Siripuram is derived from **CartoDEM version 3 (1
arc-second), © NRSC/ISRO**, downloaded from Bhuvan; the raw tile is not
redistributed here, only the clipped 49 × 43 cell extract. The land use / land
cover (SISDP 1:10,000) and the flood and cyclone hazard-zone overlays are served
live from **NRSC/ISRO Bhuvan** WMS and remain © NRSC/ISRO; the viewer credits them in Cesium's attribution container whenever one is on screen. Bhuvan's capabilities document declares no fees and no access constraints; heavy or commercial use should be cleared with NRSC.
