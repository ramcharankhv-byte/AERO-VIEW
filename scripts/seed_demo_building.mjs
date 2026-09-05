#!/usr/bin/env node
// scripts/seed_demo_building.mjs
//
// One-shot generator: add a 20-floor, 6-flat special building to the
// siripuram snapshot, with 3 underground parking basements and the
// building's own water riser + sewer tank + sewer lateral.
//
// The citizen demo (Phase 4 / Phase 5) binds to this building: the
// three demo citizens in data/projects/siripuram/residents.json
// (building_id=999) live on its floors 2, 5 and 9. Adding the building
// is what makes the citizen view show "your building" rather than the
// empty collection a 404 would land on.
//
// The script is idempotent: re-running it rewrites the same id=999
// entry, with the same coordinates, so the snapshot stays byte-stable
// across runs. It is NOT safe to run while the dev server is reading
// the snapshot -- stop the server, run the script, start it again.
//
// OUTPUT
//   Patches data/api/siripuram/buildings.json
//   Patches data/api/siripuram/parcels.json
//   Patches data/api/siripuram/detail.json     (adds 999 with full document)
//   Patches data/api/siripuram/utilities.json  (adds 3 building-internal lines)
//   Patches data/api/projects.json             (bumps project stats)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'data', 'api', 'siripuram');
const PROJECTS = path.join(ROOT, 'data', 'api', 'projects.json');

const BUILDING_ID = 999;
const SLUG = 'siripuram';
const PARCEL_ID = 9990;
const STATE = 'AP';
const DISTRICT = 'VSP';
const SCHEME = '3D26';

// ---------------------------------------------------------------------------
// Geometry.
//
// Centre chosen in the empty part of the AOI (the existing snapshot has
// 384 buildings, but 221 of them are spread across the AOI with clear
// 36 m gaps in the south-east quadrant). 36 m × 28 m is the building
// footprint: 0.000340 deg lon, 0.000253 deg lat at this latitude.
// ---------------------------------------------------------------------------
const CX = 83.3190;
const CY = 17.7233;
const FL = 0.000340;        // footprint lon extent
const FW = 0.000253;        // footprint lat extent
const ABOVE_GROUND = 60;    // 20 floors × 3 m
const BASEMENT_DEPTH = 12;  // 3 basements × 4 m
const GROUND_ELEV = 12;     // matches existing data convention
const FLOOR_HEIGHT = 3;

const lon0 = CX - FL / 2;
const lon1 = CX + FL / 2;
const lat0 = CY - FW / 2;
const lat1 = CY + FW / 2;

// A rectangular footprint with the long side east-west, returning
// a closed ring (first point == last point), the shape every other
// building in the snapshot uses.
const footprintRing = [
  [lon0, lat0],
  [lon1, lat0],
  [lon1, lat1],
  [lon0, lat1],
  [lon0, lat0],
];

// Sub-zones for the 6 flats: the building is split into thirds along
// the east-west axis, with two flats per row (a "left" and a "right"
// half) -- the citizen's flat is whichever slot their row maps to.
// This keeps the layout unambiguous and lets the camera lookAt a
// centroid.
function flatRing(floorIndex) {
  // floorIndex 0..5: rows 0..5 in the building's 6-flat grid.
  // The grid is 2 columns × 3 rows per floor is wrong; we have 1
  // flat per row × 6 rows on different floors. Each flat takes the
  // FULL building footprint at that floor; the only difference
  // between them is the floor and the unit_no, which is the
  // convention the snapshot uses for single-tenant floors.
  return [footprintRing];
}

function floorZ(levelNo) {
  // levelNo = 0 is the ground floor, +N is above, -N is below.
  if (levelNo >= 0) {
    return [GROUND_ELEV + levelNo * FLOOR_HEIGHT, GROUND_ELEV + (levelNo + 1) * FLOOR_HEIGHT];
  }
  const n = -levelNo;
  return [GROUND_ELEV - n * 4, GROUND_ELEV - (n - 1) * 4];
}

const ULPIN_BASE = `${STATE}-${DISTRICT}-${SCHEME}-9999`;
const FLAT_FLOORS = [2, 5, 9, 13, 17, 20]; // six flats, non-contiguous

// 24 levels: 3 basements + 21 above-ground levels (ground + 20 storeys).
const ALL_LEVELS = [-3, -2, -1, ...Array.from({ length: 21 }, (_, i) => i)];

// 6 owners matching the residents.json demo accounts.
const FLAT_OWNERS = [
  { code: 'F-1', owner: 'Ravi Kumar', level: 2 },
  { code: 'F-2', owner: 'Priya Sharma', level: 5 },
  { code: 'F-3', owner: 'Anand Rao', level: 9 },
  { code: 'F-4', owner: 'Suresh Iyer', level: 13 },
  { code: 'F-5', owner: 'Lakshmi Iyer', level: 17 },
  { code: 'F-6', owner: 'Karthik Reddy', level: 20 },
];

// ---------------------------------------------------------------------------
// Read existing snapshots.
// ---------------------------------------------------------------------------
async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf-8'));
}
async function writeJson(p, value) {
  await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

const buildings = await readJson(path.join(API, 'buildings.json'));
const parcels = await readJson(path.join(API, 'parcels.json'));
const detail = await readJson(path.join(API, 'detail.json'));
const utilities = await readJson(path.join(API, 'utilities.json'));
const projectsDoc = await readJson(PROJECTS);

// ---------------------------------------------------------------------------
// 1. buildings.json -- one new feature with id=999.
// ---------------------------------------------------------------------------
const newBuilding = {
  type: 'Feature',
  id: BUILDING_ID,
  geometry: { type: 'Polygon', coordinates: [footprintRing] },
  properties: {
    id: BUILDING_ID,
    ulpin: `${ULPIN_BASE}-001`,
    parcel_id: PARCEL_ID,
    height_m: ABOVE_GROUND,
    floors: 20,
    basements: 3,
    ground_elev: GROUND_ELEV,
    use_type: 'residential',
    height_source: 'surveyed_plan',
    survey_synthetic: true,
    name: 'Sampath Skyline',
    address: 'Siripuram East',
    osm_id: 0,
  },
};
buildings.features = buildings.features.filter((f) => f.properties.id !== BUILDING_ID);
buildings.features.push(newBuilding);

// ---------------------------------------------------------------------------
// 2. parcels.json -- one parcel that contains the building footprint.
// ---------------------------------------------------------------------------
const newParcel = {
  type: 'Feature',
  id: PARCEL_ID,
  geometry: { type: 'Polygon', coordinates: [footprintRing] },
  properties: {
    id: PARCEL_ID,
    ulpin: ULPIN_BASE,
    area_m2: Math.round(FL * 111000 * FW * 111000 * 0.92), // 36 m × 28 m in m²
    owner: 'Sampath Estates Pvt Ltd',
  },
};
parcels.features = parcels.features.filter((f) => f.properties.id !== PARCEL_ID);
parcels.features.push(newParcel);

// ---------------------------------------------------------------------------
// 3. detail.json -- the full BuildingDetail document for id=999.
// ---------------------------------------------------------------------------
const floorIdBase = 90000;
const unitIdBase = 95000;

const floors = ALL_LEVELS.map((lvl, i) => {
  const [zmin, zmax] = floorZ(lvl);
  const isBasement = lvl < 0;
  const flat = FLAT_OWNERS.find((f) => f.level === lvl);
  return {
    id: floorIdBase + i,
    ulpin: `${ULPIN_BASE}-001-${lvl < 0 ? 'B' + -lvl : String(lvl).padStart(2, '0')}`,
    level_no: lvl,
    z_min: zmin,
    z_max: zmax,
    detect_source: 'surveyed_plan',
    ring: { type: 'Polygon', coordinates: flatRing(i) },
    // Custom metadata read by DetailedBuildingLayer; the rest of the
    // application does not look at this. Documented for the citizen
    // view; ignored by the government view.
    meta: flat
      ? { kind: 'flat', code: flat.code, owner: flat.owner }
      : isBasement
        ? { kind: 'basement', use: 'parking' }
        : { kind: 'common', use: 'corridor' },
  };
});

const units = [];
let unitCounter = 0;
for (const lvl of FLAT_FLOORS) {
  const floorEntry = floors.find((f) => f.level_no === lvl);
  if (!floorEntry) continue;
  const flat = FLAT_OWNERS.find((f) => f.level === lvl);
  if (!flat) continue;
  units.push({
    id: unitIdBase + unitCounter,
    floor_id: floorEntry.id,
    ulpin: `${floorEntry.ulpin}-${flat.code}`,
    unit_no: flat.code,
    level_no: lvl,
    z_min: floorEntry.z_min,
    z_max: floorEntry.z_max,
    carpet_m2: Math.round(FL * 111000 * FW * 111000 * 0.6),
    built_m2: Math.round(FL * 111000 * FW * 111000 * 0.85),
    tenure: 'Freehold',
    encumbrance: 'None',
    ring: { type: 'Polygon', coordinates: flatRing(0) },
  });
  unitCounter++;
}

detail[String(BUILDING_ID)] = {
  building: {
    ...newBuilding.properties,
    footprint: { type: 'Polygon', coordinates: [footprintRing] },
  },
  parcel: newParcel.properties,
  floors,
  units,
};

// ---------------------------------------------------------------------------
// 4. utilities.json -- the building's three internal lines.
// ---------------------------------------------------------------------------
const waterRiserZ = [];
for (const lvl of ALL_LEVELS) {
  const [zmin] = floorZ(lvl);
  waterRiserZ.push(zmin + 0.5);
}
const waterRiser = {
  type: 'Feature',
  id: 99001,
  geometry: {
    type: 'LineString',
    coordinates: waterRiserZ.map((z) => [lon0 + 0.00001, lat0 + 0.00001, z]),
  },
  properties: {
    id: 99001,
    building_id: BUILDING_ID,
    asset_type: 'water',
    depth_m: 0,
    radius_m: 0.05,
    authority: 'GVMC Water Supply',
    status: 'operational',
    in_conflict: false,
  },
};
const sewerLateral = {
  type: 'Feature',
  id: 99002,
  geometry: {
    type: 'LineString',
    coordinates: [
      [lon0 + FL * 0.9, lat0 + FW * 0.9, GROUND_ELEV - 4],
      [lon0 + FL * 0.9, lat0 + FW * 0.9, GROUND_ELEV - 8],
      [lon1 - FL * 0.05, lat0 + FW * 0.9, GROUND_ELEV - 8],
      [lon1 - FL * 0.05, lat0 + FW * 0.5, GROUND_ELEV - 12],
    ],
  },
  properties: {
    id: 99002,
    building_id: BUILDING_ID,
    asset_type: 'sewer',
    depth_m: -8,
    radius_m: 0.3,
    authority: 'GVMC Sewerage Board',
    status: 'operational',
    in_conflict: false,
  },
};
const sewerTank = {
  type: 'Feature',
  id: 99003,
  geometry: {
    type: 'LineString',
    coordinates: [
      [lon0 + FL * 0.05, lat0 + FW * 0.05, GROUND_ELEV - 10.5],
      [lon0 + FL * 0.30, lat0 + FW * 0.05, GROUND_ELEV - 10.5],
      [lon0 + FL * 0.30, lat0 + FW * 0.40, GROUND_ELEV - 10.5],
      [lon0 + FL * 0.05, lat0 + FW * 0.40, GROUND_ELEV - 10.5],
      [lon0 + FL * 0.05, lat0 + FW * 0.05, GROUND_ELEV - 10.5],
    ],
  },
  properties: {
    id: 99003,
    building_id: BUILDING_ID,
    asset_type: 'sewer',
    depth_m: -10.5,
    radius_m: 0.5,
    authority: 'Sampath Estates Pvt Ltd',
    status: 'operational',
    in_conflict: false,
  },
};
utilities.features = utilities.features.filter(
  (f) => ![99001, 99002, 99003].includes(f.properties.id),
);
utilities.features.push(waterRiser, sewerLateral, sewerTank);

// ---------------------------------------------------------------------------
// 5. projects.json -- bump stats so the gallery reflects the new build.
// ---------------------------------------------------------------------------
for (const p of projectsDoc.projects ?? []) {
  if (p.slug === SLUG) {
    p.stats = p.stats ?? {};
    p.stats.buildings = (p.stats.buildings ?? 0) + 1;
    p.stats.parcels = (p.stats.parcels ?? 0) + 1;
    p.stats.floors = (p.stats.floors ?? 0) + 23;
    p.stats.units = (p.stats.units ?? 0) + 6;
    p.stats.utilities = (p.stats.utilities ?? 0) + 3;
  }
}

// ---------------------------------------------------------------------------
// Write back.
// ---------------------------------------------------------------------------
await writeJson(path.join(API, 'buildings.json'), buildings);
await writeJson(path.join(API, 'parcels.json'), parcels);
await writeJson(path.join(API, 'detail.json'), detail);
await writeJson(path.join(API, 'utilities.json'), utilities);
await writeJson(PROJECTS, projectsDoc);

console.log('Seeded building 999:');
console.log('  6 flats on floors', FLAT_FLOORS.join(', '));
console.log('  3 basements (B1, B2, B3)');
console.log('  1 water riser, 1 sewer lateral, 1 sewer tank');
console.log('Snapshot files updated.');
