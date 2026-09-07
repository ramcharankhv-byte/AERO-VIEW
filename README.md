# 3D ULPIN — Vertical Property Mapper

A three-dimensional cadastral viewer for Indian urban land administration. The
application models the full vertical stack — **parcel → building → floor →
unit** — together with the underground utility corridors that can intersect a
basement, and records the provenance of every attribute it displays.

Land records are conventionally held and drawn in two dimensions, while the
rights they describe are not. This application renders the vertical extent
directly and labels each value with its source, because most of the values are
inferred rather than surveyed: across the demonstration area of interest, 6% of
buildings carry a height in OpenStreetMap and 90% of storey counts are
estimated from footprint area and building tags.

![City view](docs/shots/1-city.png)

---

## Contents

- [Quick start](#quick-start)
- [Projects](#projects)
- [Authentication and roles](#authentication-and-roles)
- [Data provenance](#data-provenance)
- [Rendering](#rendering)
- [Basemap and context overlays](#basemap-and-context-overlays)
- [Infrastructure sites](#infrastructure-sites)
- [Manual edit](#manual-edit)
- [Identifier scheme](#identifier-scheme)
- [Architecture](#architecture)
- [API](#api)
- [Verification](#verification)
- [Current state](#current-state)
- [Not implemented](#not-implemented)
- [Licensing](#licensing)

---

## Quick start

```bash
npm install                # also copies Cesium assets into public/cesium
npm run dev                # http://localhost:3000
```

**The database is optional at runtime.** Route handlers query PostGIS first and
fall back to the committed snapshots in `data/api/<slug>/`, so `npm run dev`
alone serves the complete application, gallery included. Every response carries
an `x-ulpin-backend: postgis|snapshot` header identifying the path that served
it, resolved **per project**: with the database running and a project that
exists only as a snapshot, a global probe would incorrectly report `postgis`.

To run against PostGIS and regenerate data:

```bash
docker compose up -d       # PostGIS 16 + PostGIS 3.4 + SFCGAL
npm run db:schema          # only if the volume already existed
npm run seed               # fetch → clip DEM → estimate → hazard → seed → utilities → roads → export
```

`/` is the project gallery; each project's viewer is at `/p/<slug>`, for example
[`/p/siripuram`](http://localhost:3000/p/siripuram).

### Seeding and the geospatial toolchain

`npm run seed` uses only the Python standard library. The single stage with
third-party requirements is the DEM clip and sample (`scripts/dem.py`:
`gdalwarp`, `rasterio` or `gdallocationinfo`, `pyproj`). Without them the script
reports the omission and every building retains the 12.0 m placeholder
elevation. To seed with real ground elevation, create the seed-only toolchain
once and run the pipeline from it:

```bash
# user-space, no administrator rights required
micromamba create -y -p ./.gdal-env -c conda-forge python=3.12 gdal rasterio pyproj
npm run seed:geo           # = .gdal-env/python scripts/seed.py, same arguments as seed
```

### Migrating an existing volume

A PostGIS volume predating multi-project support should be migrated rather than
re-seeded. The migrations are additive and idempotent; none drops a table or
deletes a row.

```bash
for m in 001_multi_project 002_cartodem_bhuvan 003_hazard_exposure 004_utility_categories; do
  docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
    -f - < db/migrations/$m.sql
done
```

Migration 002 adds the ground-elevation provenance columns and the Bhuvan
overlay block, and is required before re-seeding.

### Environment

All variables are optional except `SESSION_SECRET`, which is required for any
deployment where sessions must survive a restart.

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | HMAC key for the `ulpin_session` cookie. Unset, a random key is generated per process and sessions do not survive a restart. |
| `DATABASE_URL` | PostGIS connection. Unreachable, handlers fall back to snapshots. |
| `ULPIN_REDIS_URL`, `ULPIN_CACHE_VERSION` | Optional read-through cache for per-building detail. Unreachable Redis degrades silently and is logged once. |
| `NEXT_PUBLIC_CESIUM_TOKEN` | Cesium ion token. Affects **terrain** and Photoreal 3D Tiles only; imagery does not use ion. Without one the globe falls back to a flat ellipsoid and displays a dismissible notice. |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | Bills Google Photorealistic 3D Tiles to your own key instead of going through Cesium ion. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Adds "Mapbox Satellite" to the imagery list. |
| `NEXT_PUBLIC_DRONE_ORTHO_URL`, `..._CREDIT` | XYZ tile template for a drone orthophoto pyramid, bounded to the demo AOI. |
| `ULPIN_EDITS_PATH` | Overrides the manual-edit store location. |

---

## Projects

One project is one area of interest: a bounding box, the revenue codes its
identifiers are minted under, a status, and the cadastral stack built inside it.
The gallery at `/` lists them.

| Project | Slug | Bounding box | Ground elevation |
|---|---|---|---|
| Siripuram, Visakhapatnam | `siripuram` | `83.3130,17.7180,83.3245,17.7280` | CartoDEM v3, EGM96 MSL |
| Banjara Hills Ward, Hyderabad | `hyderabad-banjara` | `78.4300,17.4100,78.4450,17.4250` | placeholder (12.0 m) |
| Visakhapatnam infrastructure | `vizag-infra` | Asilmetta / Gnanapuram | placeholder (12.0 m) |

Banjara Hills was generated from the same pipeline as Siripuram to demonstrate
that no property of the first project is hardcoded. `vizag-infra` is a minimal
cadastre that exists to carry the two [infrastructure
sites](#infrastructure-sites).

### Project record

| Field | Meaning |
|---|---|
| `slug` | URL segment and directory name, `^[a-z0-9][a-z0-9-]{0,63}$` |
| `bbox` | west, south, east, north — the camera frame and the Overpass query extent |
| `state_code`, `district_code`, `scheme_code` | identifier prefix, e.g. `TS-HYD-3D26` |
| `status` | `draft` / `generating` / `ready` / `failed`; only `ready` is openable |
| `stats` | entity counts, denormalised so a gallery card requires neither seven `COUNT(*)` queries nor a database |
| `elev_source`, `elev_datum` | `cartodem_v3` + `msl_egm96` where a DEM was sampled; `placeholder` + null otherwise |
| `bhuvan_layers` | optional `{ lulc, flood, cyclone }` WMS layer names; absent means no Context (ISRO) group |

### Generating a project

```bash
npm run seed -- --slug=hyderabad-banjara --name="Banjara Hills Ward" \
  --bbox=78.4300,17.4100,78.4450,17.4250 --state=TS --district=HYD
```

The command creates or updates the project row, caches the raw Overpass response
to `data/projects/<slug>/osm.json`, runs clip DEM → estimate → seed → utilities
→ streets → export scoped to that project, writes `data/api/<slug>/`, and
populates `projects.stats`. Placing an NRSC CartoDEM tile at
`data/projects/<slug>/dem_raw.tif` and running `npm run seed:geo` produces real
ground elevation; otherwise the project records a placeholder.

`npm run seed` with no arguments regenerates the demo project using the same
bounding box, codes and file paths, and requires no network access because its
OSM extract is committed.

Three inputs are rejected at entry with a non-zero exit, before any Overpass
request: a bounding box over **4 km²**, an aspect ratio worse than **3:1**, or
malformed coordinates. The first two are Overpass etiquette; the third is
almost always two transposed values.

### Scoping

`parcel`, `building` and `utility` carry a `project_id`. `floor` and `unit`
deliberately do not — they inherit one through `building`, and a duplicated
column would be a second answer to the same question with nothing enforcing
agreement.

Parcel **numbering** restarts at 0001 in every project; the state and district
prefix keeps identifiers distinct, as the national scheme intends.
`AP-VSP-3D26-0001` and `TS-HYD-3D26-0001` are different parcels in different
districts. Row **ids** remain globally unique, because they are what foreign
keys and `/api/p/<slug>/building/:id` address rows by.
`scripts/build_geometry.sql` computes both: a per-project ordinal for the
identifier, and that ordinal plus an offset for the primary key.

Projects do not share snapshots, manual edits, OSM extracts, DEM tiles or survey
registers. They do currently share the owner-organisation pool and the utility
authority names in `scripts/utilities.sql`, which name bodies operating in
Visakhapatnam. On another area of interest these are placeholders that carry a
real body's name in the wrong city, and should be read as synthetic accordingly.

---

## Authentication and roles

Both the gallery and the viewer require a session; anonymous visitors are
redirected to `/login`. Sessions are HMAC-signed cookies (`ulpin_session`) with
a sliding 30-day total age.

| Role | Sign-in | Scope |
|---|---|---|
| **Government** | email + password against `data/gov_users.json` (bcrypt) | full cadastre; the only role permitted to write |
| **Citizen** | identifiers resolving to one flat | responses filtered server-side to their own building, with their floor and unit claims narrowing the panel to their flat |

Role checks are pure functions in `lib/auth/access-pure.ts`, which imports
nothing from Next and is therefore testable from a plain Node script;
`lib/auth/access.ts` wraps them and returns responses. The store's `session`
field drives presentation only — tinting the citizen's own flat, hiding an Edit
control they may not use. It is **not** an access control: the server already
filters a citizen's responses, so a tampered client value changes what is drawn
and nothing about what is served.

---

## Data provenance

The distinction between sourced and generated data is enforced in the data
model, not only in documentation.

| Layer | Source | Status |
|---|---|---|
| Building footprints | OpenStreetMap (ODbL) | **Real** |
| Road centrelines | OpenStreetMap (ODbL) | **Real** |
| Storey counts, 24 of 385 (6%) | `building:levels` / `height` tags | **Real** (`osm_tag`) |
| Storey counts, 346 of 385 (90%) | area + building-tag heuristic | **Estimated** (`estimated`) |
| Storey counts, 15 of 385 (4%) | `data/surveyed_plans.json` | **Synthetic demo register** (`surveyed_plan` + `survey_synthetic`) |
| Ground elevation, Siripuram | CartoDEM v3 1 arc-second, NRSC/ISRO, sampled at each footprint centroid, EGM96 orthometric | **Real** (`dsm_dem`, `elev_source: cartodem_v3`) |
| Ground elevation, other projects | no DEM tile supplied → 12.0 m default | **Placeholder** (`placeholder`) |
| Land use class (overlay and panel row) | NRSC SISDP 1:10,000 (2016–19), Bhuvan WMS | **Real**, external, context only |
| Flood / cyclone hazard zones | NRSC national-scale, Bhuvan WMS | **Real**, external, one class over the whole AOI |
| Flood / cyclone exposure grading | `scripts/hazard.py` over the CartoDEM surface and coastline | **Derived**, relative within the AOI, not an NRSC rating |
| Parcel boundaries | Voronoi plots around clustered footprints | **Derived, not surveyed** |
| Owners, tenure, encumbrances | generated placeholders | **Synthetic** |
| Utility alignments | offsets from road centrelines | **Representative, not as-built** |
| Street geometry and class | OpenStreetMap (ODbL) | **Real** |
| Street names, 10 of 131 | OSM `name` tag | **Real** (`name_source: osm_name`) |
| Street names, 121 of 131 | derived from position and nearest named street | **Derived** (`name_source: derived`) |
| Street references (`STR-###`), lengths | computed by `scripts/build_roads.mjs` | **Derived** |
| Building names, 60 of 385 | OSM `name` tag | **Real** |
| Building names, 325 of 385 | `lib/mock/` name banks, seeded by building id | **Synthetic** (`generated`) |
| Building type, area, occupancy, owner, status | `lib/mock/`, derived from real floors and units | **Synthetic demo register** |
| Façade texture and window grid | drawn per `use_type` by `lib/cesium/textures.ts` | **Synthetic, illustrative** |
| Manual edits | entered in the viewer, stored in `data/projects/<slug>/edits.json` | **Local, no authority** |

`data/surveyed_plans.json` carries a `_synthetic: true` flag, threaded through
the `building.survey_synthetic` column to the DetailPanel, which renders the
provenance badge as **"Surveyed plan (demo)"**. Generated data is not permitted
to present with the authority of a real survey.

### Ground elevation

`data/projects/siripuram/dem_raw.tif` is the NRSC CartoDEM v3 tile `N17 E083`
(1 arc-second; gitignored at 51 MB). `scripts/dem.py` clips it to the bounding
box with `gdalwarp` into the committed `data/projects/siripuram/dem.tif`
(49 × 43 cells, 8 KB, nodata −32768), and `02_heights.py` samples it at every
footprint centroid.

The tile carries no vertical-datum key and no NRSC sidecar, but reads
−5 to −54 m over dry land, which is possible only as a height above the WGS84
ellipsoid. Every sample is therefore converted to EGM96 orthometric height with
`pyproj`, and the project records `elev_datum: msl_egm96`. Siripuram's ground
runs 19.6–82.6 m MSL. A building over a nodata cell would retain 12.0 m with
`ground_source: placeholder`; none does.

The viewer reconciles every stack against the terrain it draws
(`lib/cesium/terrain.ts`) and logs, once per load, the mean and largest
difference between the stored `ground_elev` and Cesium World Terrain. A mean
near −65 m is expected for Siripuram: World Terrain is ellipsoidal and the
stored values are MSL, and that constant offset is what the reconciliation
removes. Only rendering is reconciled; stored values are never modified.

### Hazard exposure

Bhuvan's flood and cyclone layers return a single polygon over an area of
interest 1.2 km across. Displayed alone they wash the whole ward one colour and
distinguish nothing within it. `scripts/hazard.py` therefore derives a local
exposure index for every building from the project's own CartoDEM surface and
the coastline in the same tile, and the viewer paints it in four graded classes.

| Weight | Flood exposure | Cyclone exposure |
|---|---|---|
| highest | ground height above sea level (0.45) | distance to shoreline (0.50) |
| middle | depth below surroundings within 250 m (0.40) | exposure of the ground above its surroundings (0.30) |
| lowest | distance to shoreline (0.15) | building height, as wind load (0.20) |

Class boundaries are fixed scores rather than quantiles, so a class means the
same thing in every project and seeding a new area cannot re-grade an existing
one. Over Siripuram this yields 127 low / 132 moderate / 99 high / 27 severe for
flood and 136 / 134 / 104 / 11 for cyclone; the two disagree for 309 of the 385
buildings, since low sheltered ground that floods is not the exposed high ground
that the wind reaches. Every value carries `derived` provenance in the
DetailPanel, and both legend keys state in words that the grading is computed
locally and is not an NRSC rating. The Bhuvan zone remains underneath at 25%
opacity as the national classification it is.

### Streets

`scripts/build_roads.mjs` merges 265 OSM ways into 131 logical streets — named
ways grouped by name, unnamed ways by shared endpoints within a class —
computes a geodesic length for each, and freezes the result as
`data/api/<slug>/roads.json`, so `STR-###` references are stable and reviewable
in a diff rather than recomputed per request.

The 121 streets OSM does not name are not labelled "Road 1". Each is named from
its position relative to the nearest named street, in the convention
Visakhapatnam uses — *Harbour Park Road 1st Cross*, *Chinna Waltair 1st Main
Road* — and carries `name_source: 'derived'` together with the anchor it was
named from. The panel states this and directs the user to `STR-###` as the
reference that claims nothing.

### Synthetic building register

`lib/mock/` attaches a register-style record to every building: a name, a
`BLD-####` reference, a type, a built-up area, an occupancy, an owner and a
status. It is deterministic — seeded from the building's integer id via
mulberry32 with a separate salt per field — so a building presents the same
values on every reload, in either backend, after a restart.

It does not overwrite sourced data. Floors, height, identifier, parcel,
footprint and coordinates are passed through unchanged; built-up area is summed
from the real unit rows; the building type is chosen only from subtypes the real
use type and storey count permit. The 60 buildings carrying a real OSM name and
the 7 with a real address retain them verbatim, marked `osm` in the panel while
generated values are marked `demo`.

Removing `lib/mock/` and its single call site in `lib/db.ts` returns the
application to sourced data only, with no component changes: the fields are
merged as `Partial<BuildingMock>`, so every consumer already handles their
absence.

---

## Rendering

### Building styles

Two styles, selected in the Layers panel and carried in the URL as
`?style=schematic|photoreal`.

**Schematic** renders the application's own geometry: one extruded polygon per
footprint plus a flat roof cap 0.05 m above it. The wall carries a window-grid
texture drawn per `use_type` onto a canvas at runtime — warm plaster for
residential, a curtain wall for commercial, sandstone for institutional, coated
metal for industrial. Four canvases exist in total and every wall in a project
shares them, so the texture requires no HTTP request and no per-building upload.
The tile is 3 m × 3.2 m — one bay, one storey — repeated
`(perimeter ÷ 3 m, storeys)` times, so the number of window rows on a building
equals its storey count. `BuildingModelLayer` uses the same rhythm for the
building under inspection, so the pattern does not shift when a block is opened.

Each building takes a deterministic ±8% brightness, seeded from its id with the
generator `lib/mock/` uses for the synthetic register. Without it a row of
same-use blocks is one image repeated, which reads as a single long building.

Beyond 1,500 m the entity tier hands off to `BuildingsFarLayer`, a single
batched `Primitive` carrying a flat-coloured silhouette. The two distance
conditions are back-to-back, so no footprint is drawn twice.

**Photoreal** is Google Photorealistic 3D Tiles, brokered through Cesium ion.
The tileset is a scene primitive rather than an entity, because 3D Tiles have no
entity representation, and it is constructed lazily, so a session that never
selects it consumes no quota. The schematic extrusions remain beneath it at
alpha 0.01 rather than being hidden, because `scene.pick` does not return an
entity with `show: false`. Everything downstream of a pick — the identifier
card, the floor ladder, the basement conflict list — therefore continues to work
with no photoreal-specific code path elsewhere in the application. If the tiles
fail to load, the style falls back to Schematic and a notice states the reason.

### Lighting

The scene opens at **16:30 local** on a fixed date. At that hour the sun sits
approximately 20° above the horizon and casts a shadow roughly three times a
building's height, which distinguishes a six-storey block from a two-storey one
before any label is read. An overhead sun places the shadow beneath the building
and flattens the massing. The Sun slider moves the hour between 06:00 and 18:00;
its off position removes lighting and shadows entirely and is also the reduced
path for a weak GPU.

Ambient occlusion (`lib/cesium/lighting.ts`) darkens the contact between a wall
and the ground and the gap between adjacent blocks, at a scale a 2048-pixel
shadow map spread over four kilometres cannot resolve. It is skipped rather than
degraded on the low-end GPU profile, since a full-screen horizon-based ray march
is the per-fragment cost that profile exists to avoid, and the StatusBar reports
when it is off, distinguishing an unsupported context from a deliberate
omission.

Antialiasing is 4× MSAA on a capable GPU and FXAA on a weak one, determined once
at boot by `lib/cesium/perf.ts` from the WebGL renderer string.

### Floors and units

An isolated floor is drawn as a thin base plate at its base Z plus a translucent
shell over its full height, with every unit on it standing on that plate as its
own solid box — co-visible and co-pickable rather than a level below.

Two properties keep the flats visible and both are load-bearing. The shell is
drawn at `FLOOR_VIEW.SHELL_ALPHA`, because at full slab thickness a level's
volume encloses its own units and wins the depth test. And `Picker` drill-picks
and takes the topmost **unit** where the ray found one, because otherwise the
shell in front of the flats wins the pick. The plate or shell resolves as the
floor only where no unit lies under the cursor — the level's own space, meaning
corridors and common areas.

The levels below the isolated one are drawn as thin context plates at their own
heights, so the isolated plate reads as sitting at a height rather than on the
ground. These plates are untagged and therefore invisible to `Picker`. Levels
above are not drawn: they lie between the camera and the floor under inspection,
and each would consume one of the six slots in `Picker`'s bounded drill, which
on a tall building would leave no flat selectable.

Each flat is inset `FLOOR_VIEW.UNIT_INSET_M` from its stored footprint and
lifted `FLOOR_VIEW.UNIT_LIFT_M` off the plate, at render time only. Units are a
grid subdivision, so neighbours share wall lines in the database; drawn as
stored they z-fight, and in section they merge into one slab. The database
geometry, the API and the stored identifiers are unmodified. Every distance,
alpha and threshold behind this is defined in `FLOOR_VIEW` in
`lib/cesium/materials.ts`.

### Section cut

Cesium exposes `ClippingPlaneCollection` on a `Globe`, a `Model` and a
`Cesium3DTileset` only. An entity's `PolygonGraphics` draws through a
`Primitive`, which has no `clippingPlanes` property, and every sliceable surface
here — plates, shells, unit volumes, slabs — is entity geometry. `lib/geo.ts`
therefore defines the half-plane once and `lib/cesium/section.ts` clips the
rings against it on the CPU, feeding the result back through the same
`CallbackProperty` mechanism the rest of the scene animates with. The clip
re-runs when the plane moves rather than per frame.

Slicing a whole building collapses every level to its plate for the same reason
the isolated floor does, and the architectural model steps aside because its
opaque walls would conceal the cut. Slice and Explode are mutually exclusive,
enforced in the store rather than in the two controls.

### Underground

Underground mode makes the globe translucent, reduces buildings to 10% alpha and
draws the buried networks as tubes at their recorded depths below the local
ground surface, each in its own corridor so several can be read at once. Depths,
corridors and colours are defined once, in `lib/underground/categories.ts`.

`lib/underground/layout.ts` decides where an asset is **drawn**. It is a pure
function: given a feature it returns a separate display geometry and the feature
returns byte-identical, which `lib/underground.test.ts` asserts by deep
comparison. The viewer may move a pipe on screen to keep several networks
legible; it never moves the record, and anything it moves the DetailPanel
reports.

Conflicts detected by `ST_3DIntersects` pulse red.

![Underground](docs/shots/6-underground.png)

---

## Basemap and context overlays

The basemap is **Esri World Imagery** and requires no key. A treatment on the
imagery layer reduces exposure and lifts saturation, which over this area of
interest renders the ground deep green. Buildings are never tinted with it, and
the contrast between dark ground and lit massing separates them by value and by
chroma simultaneously.

| Imagery | Notes |
|---|---|
| Esri World Imagery | Default. No token. |
| Esri Wayback (archive) | Historical mosaics. Requires `WAYBACK_RELEASE`. |
| Mapbox Satellite | Shown only when `NEXT_PUBLIC_MAPBOX_TOKEN` is set. |
| Drone orthophoto | Shown only when `NEXT_PUBLIC_DRONE_ORTHO_URL` is set; bounded to the demo AOI. |
| Dark vector (no imagery) | CARTO `dark_all`. Non-photographic, and the fallback. |
| None | No layer; bare globe. Intended for underground mode and clean captures. |

**Tone** switches between `GIS dark` (default) and `Natural` (unmodified
imagery). Switching either control swaps layer 0 in place: the viewer is not
rebuilt, the camera does not move, and any context overlay above layer 0 remains
in position.

Wayback releases are global snapshots and there is no API for the best release
over a given area. Select one from the [Wayback
app](https://livingatlas.arcgis.com/wayback) over the area of interest and set
`WAYBACK_RELEASE` in `lib/cesium/imagery.ts`. Left `null`, the Wayback option
resolves to current Esri imagery.

If a provider fails to load, the application logs a warning and falls back to
CARTO; the StatusBar then reports the effective basemap marked `(fallback)`, so
a degraded map is never silent. The globe is never left untextured.

### ISRO Bhuvan overlays

A project may carry a `bhuvan_layers` block naming NRSC Bhuvan WMS layers
(`https://bhuvan-vec2.nrsc.gov.in/bhuvan/ows`, WMS 1.3.0, EPSG:4326). The Layers
panel then shows a **Context (ISRO)** group with one toggle per layer the
project defines — for Siripuram: Land use (SISDP 1:10k), Flood hazard zones and
Cyclone hazard zones. They are drawn as imagery layers above the basemap (land
use at 30% opacity, hazard zones at 50%), are off by default, are credited
`© NRSC/ISRO Bhuvan` in Cesium's attribution container, and survive a basemap
change. Bhuvan is never offered as a basemap, because its vector server carries
no imagery.

With the land use overlay enabled, the Legend displays Bhuvan's own
`GetLegendGraphic`. Selecting a building issues one `GetFeatureInfo` at the
footprint centroid (lat,lon axis order, as WMS 1.3.0 with EPSG:4326 requires)
and the DetailPanel adds `LULC: <class> — SISDP 1:10k (Bhuvan)`. The lookup is
cached per building and never delays the rest of the panel. The server sends
`Access-Control-Allow-Origin: *`, so tiles and lookups go to Bhuvan directly
with no proxy route.

Attribution is a licence obligation. Esri, Maxar, CARTO, OSM and, with an
overlay enabled, NRSC/ISRO Bhuvan credits render bottom-left and must not be
concealed. Esri's World Imagery service additionally carries its own [terms of
use](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)
for heavy or commercial use.

---

## Infrastructure sites

Two named structures in Visakhapatnam are modelled as sites: the **Visakhapatnam
Railway Station** (`vskp-railway-station`, 21 components) and the **Telugu Thalli
Flyover** (`telugu-thalli-flyover`, 45 components). They open from the
Infrastructure panel or directly by URL, for example
`/p/vizag-infra?site=telugu-thalli-flyover&cmp=TTF-P-014`.

A site is not bounded by a project's area of interest: the navigator flies to
the structure's anchor and terrain is sampled over the structure's own extent, so
a project can offer a landmark standing outside the ground its cadastre covers.
Both sites are therefore also offered by `siripuram`, which is the same city.
Opening a site is what fetches and builds it; closing one tears it down.

The detail card separates two categories of fact, and this separation is the
purpose of the feature:

- **CITED** — published or mapped. Platform outlines, their numbering and the
  station point come from OpenStreetMap; the platform count, station area,
  elevation and opening dates are published figures; the flyover's two
  carriageway alignments and its 1,448 m length are mapped, and its lane count
  and opening year are published.
- **DERIVED** — produced here. Shelters, foot over bridges, track positions, the
  station building, deck level, ramp gradients, the 30 m span spacing, and every
  component identifier such as `TTF-P-014`.

No station drawing, bridge schedule or survey was consulted. See
[`docs/DEMO.md`](docs/DEMO.md) for a guided walkthrough.

---

## Manual edit

Nine attributes are editable: name, type, floors, height, built-up area,
occupancy, address, owner and status. **Coordinates and the identifier are not**,
and this is enforced by the type rather than by a `disabled` attribute — they are
absent from `BuildingEdit`, so `PATCH /api/building/:id` answers `400` for them.

`lib/data/building-schema.ts` is imported by both the form and the route
handler, so a rule cannot pass in the browser and fail on the server, and a
server-only rejection renders in the same per-field slot as a local one. Saves
are pessimistic and round-trip to `data/projects/<slug>/edits.json` (gitignored;
override with `ULPIN_EDITS_PATH`). The edit overlay is applied as a pure function
over the pristine snapshot on each read, so the file cache cannot go stale and
there is no invalidation step.

Editing storeys or height updates **one** building in the scene through a
`ConstantProperty` assignment rather than rebuilding all 770 building entities.
The acceptance checks assert that the entity count is unchanged across a save,
in both building styles.

Only a government session may write. The API refuses a citizen with `403`
independently of whether the interface offers the control.

---

## Identifier scheme

```
AP-VSP-3D26-<parcel4>-<bldg3>-<floor2>-<unit2>
        e.g. AP-VSP-3D26-0042-007-05-03
```

Right-truncated for coarser entities. Floor codes are `00` for ground, `01`–`99`
above ground, and `B1`–`B9` for basements.

> **This is an unofficial vertical extension of the 14-digit ULPIN
> (Bhu-Aadhaar). It is not an official government identifier**, is not issued by
> or registered with any revenue department, and carries no legal weight.

That statement is rendered on the identifier card in the interface, not placed
in a tooltip. `lib/ulpin.ts` and `db/02_functions.sql`'s `ulpin_fmt()` implement
the same encoding, and their agreement is asserted in `lib/ulpin.test.ts`.

---

## Architecture

```
app/                     layout; / gallery; /p/[slug] viewer; /login
                         api/p/[slug]/* (12 routes), 10 unscoped aliases,
                         api/projects[/slug], api/auth/*, api/me
components/gallery/      ProjectCard, BboxSketch
components/globe/        CesiumRoot (viewer, imagery, terrain, lighting),
                         CameraDirector, Picker, Scene, BuildingTooltip
components/layers/       BhuvanOverlay, HazardRisk, Parcels, Roads,
                         Buildings, BuildingsFar, BuildingEdge, BuildingModel,
                         FloorStack, Units, Utilities, InfraSite, Conflict
components/ui/           TopBar, LayerPanel, ActionBar, FloorLadder,
                         ElevationRuler, DetailPanel, ParcelInset, NavDock,
                         StatusBar, Legend, ConflictBanner, UlpinCard,
                         Provenance, SiteNavigator, StatsPanel, PhotorealNotice
components/auth/         LoginForm
components/citizen/      CitizenAutoFrame
lib/                     projects.ts, ulpin.ts, store.ts, db.ts, types.ts,
                         bhuvan.ts, hazard.ts, sun.ts, geo.ts
                         api/, auth/, data/, mock/, infra/, underground/, cesium/
db/                      01_schema.sql, 02_functions.sql   (run by initdb)
                         migrations/001..004                (for an existing volume)
scripts/                 seed.py orchestrator, 01–05 pipeline, dem.py, hazard.py,
                         project.py, build_geometry.sql, utilities.sql,
                         build_roads.mjs, build_vizag_infra.mjs,
                         _chrome.mjs, verify_ui.mjs, check_*.mjs, shoot.mjs
data/api/<slug>/         per-project snapshots, served when the database is down
data/api/projects.json   the committed registry, so the gallery renders offline
data/projects/<slug>/    per-project inputs, Overpass cache, edits.json,
                         dem_raw.tif (ignored) and its committed clip dem.tif
```

### Invariants

Four rules the code observes and `grep` can confirm.

1. **One store, few writers.** The Zustand view store holds
   `{mode, activeBuildingId, isolatedFloor, selectedUnitId, layers, explodeT,
   theme, underground, …}`. Only `Picker` and the UI controls write to it; layer
   components read it and render. Two fields are written by `CesiumRoot` because
   only the viewer knows their values: `imageryActive` (the basemap actually in
   use after a fallback) and `ambientOcclusion` (whether the GPU accepted it).
2. **All camera motion lives in `CameraDirector`.** No `flyTo`, `zoomTo` or
   `lookAt` exists elsewhere. `CesiumRoot` performs a single `setView` to frame
   the project's bounding box at construction — the scene's initial pose, not a
   transition — and takes the bounding box as an argument, so no area-of-interest
   constant remains in the camera path.
3. **Colours and visual constants are defined once**, in
   `lib/cesium/materials.ts`.
4. **Every DetailPanel entity displays a provenance line.**

### Implementation notes

**Metric geometry is built in SQL, not Python.** Python 3.14 has incomplete
wheel coverage for `shapely` and `rasterio`, and PostGIS with SFCGAL was already
a hard dependency. The Python scripts perform fetch and attribute estimation
only — standard library, plus the optional geospatial toolchain that
`scripts/dem.py` alone requires — while extrusion, unit subdivision, utility
offsetting and conflict detection are SQL. Construction is performed in
**EPSG:32644** (UTM 44N) and transformed back to **4326**; `ST_Transform` leaves
Z unchanged, so stored solids are longitude/latitude degrees with height in
metres, which is what Cesium consumes.

**`ST_MakeSolid` is required.** `ST_3DIntersects` treats a `POLYHEDRALSURFACE`
as a shell, so a point strictly inside a prism does not intersect it, and a
corridor lying wholly within a basement envelope — the most serious form of
encroachment — would go unreported. Both the point query and the conflict pass
promote shells to solids first.

**One animation driver per layer.** `BuildingsLayer` builds its entities once;
hover, fade and hide are `CallbackProperty` closures reading a single mutable
ref, eased by one `requestAnimationFrame` loop rather than one tween per
building. Entities are distributed across a grid of data sources
(`lib/cesium/spatial-buckets.ts`) so that the view frustum can cull them: a
single batched primitive spanning the area of interest has a bounding volume
spanning the area of interest and is therefore never culled.

**Selection edges are drawn as a separate layer.** Enabling `outline` on an
extruded polygon removes it from Cesium's batched static geometry path. The
accent edge on the selected building and the quieter one on the hovered building
are therefore four entities in their own data source, repositioned through
callbacks rather than rebuilt, so the cost is constant in the number of
buildings and unaffected by an edit.

---

## API

Every cadastre endpoint is scoped by project. Ten unscoped paths remain as thin
aliases onto the demo project, because the acceptance scripts and existing
bookmarks predate projects. Alias and scoped route share a handler body, so
their responses are identical by construction rather than by review.

| Endpoint | Alias | Returns |
|---|---|---|
| `GET /api/p/:slug/buildings` | `/api/buildings` | GeoJSON FeatureCollection of every footprint |
| `GET /api/p/:slug/building/:id` | `/api/building/:id` | building with floors and units, nested |
| `PATCH /api/p/:slug/building/:id` | `/api/building/:id` | records a manual edit and returns the re-read document. `400` for a non-editable field, `422` for a validation failure, `403` for a citizen |
| `GET /api/p/:slug/building/:id/floors` | `/api/building/:id/floors` | floors for one building |
| `GET /api/p/:slug/building/:id/units` | `/api/building/:id/units` | units for one building |
| `GET /api/p/:slug/building/:id/summary` | `/api/building/:id/summary` | counts and extents without the geometry |
| `POST /api/p/:slug/query {lon,lat,z}` | `/api/query` | every entity whose 3D volume contains the point, ordered parcel < building < floor < unit |
| `GET /api/p/:slug/utilities` | `/api/utilities` | utility centrelines with depth, radius and authority |
| `GET /api/p/:slug/conflicts` | `/api/conflicts` | flagged `ST_3DIntersects` violations |
| `GET /api/p/:slug/parcels` | `/api/parcels` | surface parcels |
| `GET /api/p/:slug/roads` | `/api/roads` | merged street centrelines with names, classes and lengths |
| `GET /api/p/:slug/sites` | — | infrastructure sites offered by this project |
| `GET /api/p/:slug/infra/:site` | — | one site's full component specification |
| `GET /api/projects` | — | every project with its statistics |
| `GET /api/projects/:slug` | — | one project |
| `POST /api/auth/gov/login`, `/api/auth/citizen/login`, `/api/auth/logout` | — | session management |
| `GET /api/me` | — | the current session's role and claims |

Two failure modes are answered differently, and the gallery renders them as
distinct states:

| Status | Meaning |
|---|---|
| `404` | no component knows this slug — not the registry, not PostGIS, and no `data/api/<slug>/` exists |
| `503` | the project exists but has no exported snapshot and the database is not answering |

Reporting that a project does not exist when the database is merely stopped is
incorrect, so the two are never collapsed.

```console
$ curl -s -X POST localhost:3000/api/query -H 'Content-Type: application/json' \
    -d '{"lon":83.3245,"lat":17.72808,"z":64.9}'

parcel    AP-VSP-3D26-0001            P. Sailaja
building  AP-VSP-3D26-0001-001        Water Resourse Block   z 60.16..76.16
floor     AP-VSP-3D26-0001-001-01     Level 1                z 63.36..66.56
unit      AP-VSP-3D26-0001-001-01-02  B02                    z 63.51..66.21
```

The `z` values are metres above mean sea level (EGM96): the building's ground is
the CartoDEM sample at its centroid, 60.16 m, and Level 1 begins one storey
above it.

Responses carry `x-ulpin-backend: postgis|snapshot`, `x-ulpin-cache:
hit|miss|bypass`, and — for roads, which have no PostGIS table —
`x-ulpin-roads: derived`.

---

## Verification

```bash
npm test              # ULPIN round-trip, geometry, Bhuvan and underground assertions
npm run verify:ui     # drives real Chrome through every view mode, in both building styles
npm run check:roads   # street picking, tolerance, deselect, building precedence
npm run check:edit    # read-only guarantees, validation, save, persistence
npm run check:photoreal  # tileset lifecycle, picking through the mesh, URL round-trip
npm run check:ug      # utility depths against the per-vertex ground field
npm run check:rwd     # four viewports x two pages: layout, collisions, colour audit
npm run check:basemap # provider swaps and the fallback path
npm run auth:test     # role checks and session handling
```

The browser-driven checks target `/p/siripuram` by default; `ULPIN_URL`
overrides it.

Both pages require a session and the harness has no login step, so it must be
given a signed cookie minted with the server's own `SESSION_SECRET`:

```bash
export ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs)
npm run verify:ui && npm run check:rwd
```

`verify:ui` additionally requires the `window.__ulpinViewer` test seam, which a
production build carries only when built with `NEXT_PUBLIC_ULPIN_PROBE=1`;
`npm run dev` includes it unconditionally.

### What the checks assert

`verify:ui` walks city → building → explode → floor → unit → underground,
asserts the DOM at each step, verifies that the disabled controls are genuinely
disabled, fails on any console error, and writes screenshots to `docs/shots/`. A
final section repeats the structural walk in **both** building styles and
asserts in each that saving an edit leaves the building entity count unchanged.
Photoreal is permitted to be unavailable — Google's tiles require a live token
and quota — in which case the check asserts that the fallback to Schematic was
clean and reported.

`check:rwd` renders each viewport and audits it twice, because the colour rule
has two halves. The **chrome** must remain monochrome: every element inside a
floating panel is read back from its computed styles and reported if it carries
any hue other than the sanctioned alert red, which a class-name search could not
establish and which continues to work now that panels float over a colour scene.
The **scene** must remain in colour: the composited frame is measured for chroma
and fails below 3%, which detects an imagery treatment or texture pass that has
drained it. The check also verifies that no two panels overlap, that none runs
off-screen, and that Cesium's attribution container is never covered.

`check:rwd` runs twice, once over a project's viewer and once over the gallery
(`--gallery`). Two of its checks cannot apply to a page with no canvas — the
chroma test exists to detect a drained basemap and a gallery frame is monochrome
by design, and the attribution hit-test requires Cesium's credit container. Both
are skipped there with an explicit `n/a` line rather than left permanently red.

### Rendering backend

The acceptance harness renders on the system GPU through ANGLE, not a software
rasteriser. Shadows, ambient occlusion and MSAA are GPU features, so a
screenshot captured under SwiftShader cannot speak to any of them. Every run
prints the renderer that actually bound, and warns when the GPU was requested
and not obtained. `ULPIN_GPU=0` restores software rendering for a machine with
no adapter.

### Known limitation

`npm run check:edit` requires a clean edit store. It asserts that three
deliberately failing saves write nothing, and does not clear
`data/projects/<slug>/edits.json` before running, so a record left by a previous
successful run makes that one assertion fail. Delete the file between runs. The
remaining 30 checks, including the entity-count guarantee, pass either way.

---

## Current state

| Project | Buildings | Parcels | Streets | Floors | Units | Utility runs | Conflicts |
|---|---:|---:|---:|---:|---:|---:|---:|
| `siripuram` | 385 | 326 | 131 | 1,834 | 6,462 | 304 | 0 |
| `hyderabad-banjara` | 2,213 | 1,309 | 350 | 8,119 | 31,807 | 1,214 | 80 |
| `vizag-infra` | 2 | 2 | 2 | 0 | 0 | 15 | 0 |

- `tsc --noEmit` clean; 57/57 unit tests
- 73/73 UI checks, 26/26 street checks, 26/26 building-style checks, 31/31 edit
  checks from a clean store, underground depth checks green across all three
  projects
- Responsive checks green at 1680/1280/834/390 px on both the viewer and the
  gallery; the chrome audit reports **0 off-palette elements** at every
  viewport, and the scene audit a frame that is 48–65% coloured, with Cesium's
  attribution logo excluded from the count
- Both suites have been run against PostGIS and the snapshot backend, and the
  `POST /api/query` stack is identical between them

Siripuram currently reports no conflicts. `scripts/utilities.sql` still contains
a deliberately unauthorised sewer alignment for the 3D check to detect, and the
conflict machinery is exercised by `hyderabad-banjara`, which carries 80
`utility_through_basement` detections.

---

## Not implemented

**Measurements, Share and Split view** are rendered visibly disabled rather than
hidden, so their absence is explicit.

**Editing a storey count does not regenerate floor and unit records.** These are
cadastral child rows, and generating them would be a substantially larger
invention than generating a name. The panel states this whenever the two
disagree.

**Streets are snapshot-only.** `db/01_schema.sql` has no road table, so unlike
buildings and parcels there is no PostGIS path for `lib/db.ts` to prefer;
`GET /api/roads` sends `x-ulpin-roads: derived` to state this on the wire.

**Session revocation is per-process.** Sessions are stateless signed cookies, so
invalidating one before expiry requires a shared store that does not yet exist.

---

## Licensing

Building footprints and road centrelines are © OpenStreetMap contributors,
licensed **ODbL**. Everything derived from them here inherits that licence.

Ground elevation for Siripuram is derived from **CartoDEM version 3 (1
arc-second), © NRSC/ISRO**, obtained from Bhuvan. The raw tile is not
redistributed here; only the clipped 49 × 43 cell extract is committed.

The land use / land cover (SISDP 1:10,000) and the flood and cyclone hazard-zone
overlays are served live from **NRSC/ISRO Bhuvan** WMS and remain © NRSC/ISRO.
The viewer credits them in Cesium's attribution container whenever one is
displayed. Bhuvan's capabilities document declares no fees and no access
constraints; heavy or commercial use should be cleared with NRSC.

Google Photorealistic 3D Tiles are subject to Google Maps Platform terms and are
accessed either through Cesium ion or a supplied Google Maps API key.
