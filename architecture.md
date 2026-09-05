app/
layout.tsx
page.tsx ← composes everything, no logic
api/
buildings/route.ts ← GET all footprints (bbox) → GeoJSON
building/[id]/route.ts ← GET one building + floors + units
query/route.ts ← POST {lon,lat,z} → vertical stack at point
utilities/route.ts ← GET utility volumes
conflicts/route.ts ← GET ST_3DIntersects violations

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
UtilitiesLayer.tsx ← PolylineVolume tubes at depth
ConflictLayer.tsx ← pulsing red overlay on flagged segments
ui/
TopBar.tsx ← brand, ULPIN search, tool menus
LayerPanel.tsx ← checkboxes, explode slider, transparency, theme
ActionBar.tsx ← Explode / Isolate / Reset
FloorLadder.tsx ← DOM, absolutely positioned
ElevationRuler.tsx ← DOM, synced via worldToWindowCoordinates
DetailPanel.tsx ← property / floor / unit / utility — one component, 4 modes
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
cesium/explode.ts ← the lift animation
store.ts ← zustand
db.ts ← postgres client
scripts/
01_fetch_osm.py ← Overpass → raw geojson
dem.py ← clip the CartoDEM tile (gdalwarp), sample it, EGM96 datum
hazard.py ← per-building flood/cyclone exposure from the DEM + coastline
02_heights.py ← levels heuristic + DEM lookup
03_seed_db.py ← → PostGIS, generate floors/units/ULPINs
04_utilities.py ← pipes along road centrelines + 1 deliberate conflict
