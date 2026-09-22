app/
layout.tsx
page.tsx ← composes everything, no logic
api/
buildings/route.ts ← GET all footprints (bbox) → GeoJSON
building/[id]/route.ts ← GET one building + floors + units
query/route.ts ← POST {lon,lat,z} → vertical stack at point
utilities/route.ts ← GET utility volumes
conflicts/route.ts ← GET ST_3DIntersects violations
sites/route.ts ← GET the project's named infrastructure, as an index
infra/[site]/route.ts ← GET one site's full spec: the lazy-load boundary
section-22a/route.ts ← GET the Section 22A register, resolved onto parcel rings

components/
globe/
CesiumRoot.tsx ← viewer lifecycle, imagery, terrain, theme
CameraDirector.tsx ← ALL flyTo choreography lives here, nowhere else
Picker.tsx ← ScreenSpaceEventHandler → store actions
layers/
BhuvanOverlayLayer.tsx ← ISRO Bhuvan WMS overlays (LULC, flood, cyclone) above the basemap
HazardRiskLayer.tsx ← the derived local exposure grading, painted on the ground
BuildingsLayer.tsx ← 700 footprints, extruded, styled by state
FloorStackLayer.tsx ← active building only: per-floor slabs
UnitsLayer.tsx ← isolated floor only: per-flat volumes
ParcelsLayer.tsx ← surface parcel polygons, clamped to ground
Section22ALayer.tsx ← the 22A restricted-land marking, over both parcel layers
UtilitiesLayer.tsx ← one bucket grid PER CATEGORY, each built on demand
InfraSiteLayer.tsx ← the active station / flyover, built on demand
TopologyLayer.tsx ← pin + stem per Topology Validation finding
ui/
TopBar.tsx ← brand, ULPIN search, tool menus
TopologyBanner.tsx ← summary banner once a validation run finds something
LayerPanel.tsx ← checkboxes, explode slider, transparency, theme
UndergroundPanel.tsx ← per-category switches, generated from the registry
SiteNavigator.tsx ← the named structures, as places to go
Check.tsx ← the panel checkbox, shared by both panels
ActionBar.tsx ← Explode / Isolate / Reset
FloorLadder.tsx ← DOM, absolutely positioned
ElevationRuler.tsx ← DOM, synced via worldToWindowCoordinates
DetailPanel.tsx ← property / floor / unit / utility / component / site
ParcelInset.tsx ← 2D SVG mini-map of neighbouring parcels
NavDock.tsx ← Orbit / Pan / Zoom / Reset / Auto-spin
StatusBar.tsx ← "714 3D buildings · Siripuram 500 m · WGS 84"

lib/
bhuvan.ts ← Bhuvan WMS URLs, GetFeatureInfo parsing, labels (Cesium-free)
hazard.ts ← wording for the derived exposure ramp, shared by both key panels
ulpin.ts ← generate + parse the identifier
cesium/imagery.ts ← basemap provider registry + colour treatment
cesium/imagery-catalog.ts ← the same ids/labels, Cesium-free, for the UI
cesium/materials.ts ← the 6 material states, one place
underground/categories.ts ← THE depth hierarchy: bands, corridors, colours
underground/ground-field.ts ← terrain as a function of position
underground/use-ground-field.ts ← the shared, lazy, per-viewer field cache
underground/layout.ts ← where an asset is DRAWN. Never touches the data
infra/types.ts ← a site, its components, the fact/derived split
infra/build.ts ← spec → rings and columns. Pure, Cesium-free
cesium/explode.ts ← the lift animation
section22a/types.ts ← the 22A record, the categories, and the exact disclaimers
section22a/resolve.ts ← register entry + cadastre -> drawable feature. Pure
section22a/source.ts ← THE SEAM the real government register arrives through
store.ts ← zustand
db.ts ← postgres client
scripts/
01_fetch_osm.py ← Overpass → raw geojson
dem.py ← clip the CartoDEM tile (gdalwarp), sample it, EGM96 datum
hazard.py ← per-building flood/cyclone exposure from the DEM + coastline
02_heights.py ← levels heuristic + DEM lookup
03_seed_db.py ← → PostGIS, generate floors/units/ULPINs
04_utilities.py ← pipes along road centrelines + 1 deliberate conflict
build_vizag_infra.mjs ← the two site specs → a whole project snapshot
check_underground.mjs ← asserts every network sits at its recorded depth

---

## The underground rule

Depths, corridors and colours are stated ONCE, in `lib/underground/categories.ts`.
They used to be stated three times — in the `VALUES` list of
`scripts/utilities.sql`, in a hardcoded `DEPTHS` map in `Legend.tsx`, and in
each snapshot's own `depth_m` — and those three had already drifted apart.

Runs are hung off the terrain under each vertex, not off one AOI-wide mean.
The mean is what `scripts/utilities.sql` bakes in, and over Siripuram's 63 m of
relief it drew 48% of the "1 m deep" network above the ground, up to +40 m in
the air and through buildings.

`lib/underground/layout.ts` decides where an asset is DRAWN. It is pure: it is
handed the feature and returns a SEPARATE display geometry, and the feature
comes back byte-identical — `lib/underground.test.ts` asserts that by deep
comparison. The viewer may move a pipe on screen to keep several networks
legible; it may never move the record, and anything it moves the DetailPanel
reports.

`npm run check:ug` measures both treatments against the cadastre's own
elevations and fails if a network stops sitting at its recorded depth.

## The infrastructure rule

A site's `facts` are SOURCED and cited. Its `components` are DERIVED by us.
The panel marks every row accordingly, and that split is the point: a viewer
must be able to tell "there are eight platforms" — true, and checkable — from
"this pillar is 5.9 m tall", which is our arithmetic. The second must never
borrow the authority of the first.
