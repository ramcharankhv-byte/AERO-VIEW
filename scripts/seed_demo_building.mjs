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

/**
 * Flat sub-footprints: a 2x2 grid on every residential floor.
 *
 * The previous version gave every flat the FULL building footprint, so four
 * flats on a floor were four identical stacked prisms -- nothing to see and
 * nothing to click apart. A flat has to be its own volume before the viewer
 * can distinguish it, highlight it, or resolve a click to it.
 *
 * Two gaps are cut out of the plate, and both are load-bearing for the
 * rendering rather than decorative:
 *
 *   FACADE_INSET  the strip between a flat and the outer wall. Without it a
 *                 flat's wall is coplanar with the building shell and the two
 *                 z-fight; the citizen view draws the shell ghosted around a
 *                 solid flat, so they must not share a surface.
 *   CORRIDOR      the cross down the middle of the plate: the lift core and
 *                 landing. It is what makes the four flats read as four
 *                 rather than as one quartered slab.
 *
 * Grid positions, seen from above (north up), matching the flat numbering
 * 1..4 used by `flatCode`:
 *
 *   +-----------+   +-----------+
 *   |     1     |   |     2     |     1 = NW   2 = NE
 *   +-----------+   +-----------+
 *   +-----------+   +-----------+
 *   |     3     |   |     4     |     3 = SW   4 = SE
 *   +-----------+   +-----------+
 */
const FACADE_INSET = 0.06;   // fraction of the footprint left as facade
const CORRIDOR = 0.06;       // fraction taken by the central core

/** The four grid slots, in flat-number order (1..4). */
const FLAT_SLOTS = [
  { col: 0, row: 1, facing: 'North-West' },
  { col: 1, row: 1, facing: 'North-East' },
  { col: 0, row: 0, facing: 'South-West' },
  { col: 1, row: 0, facing: 'South-East' },
];

/** One flat's closed ring, as GeoJSON Polygon coordinates. */
function flatRing(slot) {
  const near = [FACADE_INSET, 0.5 - CORRIDOR / 2];
  const far = [0.5 + CORRIDOR / 2, 1 - FACADE_INSET];
  const [fx0, fx1] = slot.col === 0 ? near : far;
  const [fy0, fy1] = slot.row === 0 ? near : far;
  const x0 = lon0 + FL * fx0;
  const x1 = lon0 + FL * fx1;
  const y0 = lat0 + FW * fy0;
  const y1 = lat0 + FW * fy1;
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
}

/** Built-up area of one grid slot, in m². Same degrees->metres convention
 *  as the parcel area above, so the numbers stay comparable. */
function flatAreaM2() {
  const w = FL * (0.5 - CORRIDOR / 2 - FACADE_INSET) * 111000;
  const h = FW * (0.5 - CORRIDOR / 2 - FACADE_INSET) * 111000;
  return w * h;
}

/** Indian flat numbering: floor 2 slot 1 -> "201", floor 20 slot 3 -> "2003". */
function flatCode(level, slotNo) {
  return `${level}${String(slotNo).padStart(2, '0')}`;
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

/**
 * The residential floors. Four flats on each, so a floor is a plate with
 * four distinct volumes on it rather than one slab -- which is the whole
 * point: a citizen has to be able to see their flat apart from its
 * neighbours before "click your own flat" means anything.
 */
const FLAT_FLOORS = [2, 5, 9, 13, 17, 20];

// 24 levels: 3 basements + 21 above-ground levels (ground + 20 storeys).
const ALL_LEVELS = [-3, -2, -1, ...Array.from({ length: 21 }, (_, i) => i)];

const BUILDING_NAME = 'Sampath Skyline';
const STREET = 'Siripuram East';
const CITY = 'Visakhapatnam';
const PIN = '530003';

/**
 * Owners, one per flat, keyed "<level>-<slot>".
 *
 * The three entries that match data/projects/siripuram/residents.json are the
 * demo logins and MUST stay in step with it -- the citizen session carries
 * `unit` as a string code and the viewer matches it against `unit_no`. The
 * rest are here so a floor reads as a real floor: three neighbours the
 * citizen can see the shape of and cannot open.
 */
const OWNERS = {
  '2-1': 'Ravi Kumar',        // demo login  111122223333
  '2-2': 'Meena Patnaik',
  '2-3': 'Joseph Fernandes',
  '2-4': 'Sanjay Varma',
  '5-1': 'Aruna Devi',
  '5-2': 'Priya Sharma',      // demo login  222233334444
  '5-3': 'Vikram Naidu',
  '5-4': 'Fatima Begum',
  '9-1': 'Rajesh Gupta',
  '9-2': 'Sunita Rao',
  '9-3': 'Anand Rao',         // demo login  333344445555
  '9-4': 'Deepak Chowdary',
  '13-1': 'Suresh Iyer',
  '13-2': 'Kavitha Menon',
  '13-3': 'Imran Sheikh',
  '13-4': 'Padma Lakshmi',
  '17-1': 'Lakshmi Iyer',
  '17-2': 'Gopal Krishna',
  '17-3': 'Rehana Yusuf',
  '17-4': 'Mahesh Babu',
  '20-1': 'Karthik Reddy',
  '20-2': 'Shanti Prasad',
  '20-3': 'Nikhil Jain',
  '20-4': 'Ananya Bose',
};

// ---------------------------------------------------------------------------
// Read existing snapshots.
// ---------------------------------------------------------------------------
/**
 * Remember how each file was formatted, so writing it back does not reformat
 * it.
 *
 * This script PATCHES committed snapshots; it does not own them. The
 * exporter writes the big API files minified, and blindly re-emitting them at
 * indent 2 turned detail.json from 3.6 MB on one line into 9.5 MB across
 * 434,718 lines -- a diff nobody can read, wrapped around a one-building
 * change, in a file that is also served over the wire. projects.json, by
 * contrast, really is kept pretty-printed and hand-readable.
 *
 * So the style is read off the file rather than decided here.
 */
const style = new Map();

async function readJson(p) {
  const raw = await fs.readFile(p, 'utf-8');
  const parsed = JSON.parse(raw);
  // Pretty-printed files put a newline after the opening brace; minified ones
  // do not. That is the only signal needed, and it does not depend on the
  // document's shape.
  const pretty = /^\s*[[{]\s*\n/.test(raw);
  style.set(p, { pretty, trailingNewline: raw.endsWith('\n') });
  return parsed;
}

async function writeJson(p, value) {
  const s = style.get(p) ?? { pretty: true, trailingNewline: true };
  const body = s.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await fs.writeFile(p, body + (s.trailingNewline ? '\n' : ''), 'utf-8');
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

// A floor's own ring stays the full plate -- the storey really is the whole
// footprint. It is the UNITS on it that are subdivided.
const floors = ALL_LEVELS.map((lvl, i) => ({
  id: floorIdBase + i,
  ulpin: `${ULPIN_BASE}-001-${lvl < 0 ? 'B' + -lvl : String(lvl).padStart(2, '0')}`,
  level_no: lvl,
  z_min: floorZ(lvl)[0],
  z_max: floorZ(lvl)[1],
  detect_source: 'surveyed_plan',
  ring: { type: 'Polygon', coordinates: [footprintRing] },
}));

const builtM2 = Math.round(flatAreaM2());
const carpetM2 = Math.round(flatAreaM2() * 0.72);

const units = [];
let unitCounter = 0;
for (const lvl of FLAT_FLOORS) {
  const floorEntry = floors.find((f) => f.level_no === lvl);
  if (!floorEntry) continue;
  FLAT_SLOTS.forEach((slot, idx) => {
    const slotNo = idx + 1;
    const code = flatCode(lvl, slotNo);
    units.push({
      id: unitIdBase + unitCounter,
      floor_id: floorEntry.id,
      ulpin: `${floorEntry.ulpin}-${code}`,
      unit_no: code,
      level_no: lvl,
      z_min: floorEntry.z_min,
      z_max: floorEntry.z_max,
      carpet_m2: carpetM2,
      built_m2: builtM2,
      tenure: 'Freehold',
      encumbrance: 'None',
      // The three fields the detail panel needs to describe a flat as a
      // home rather than as a volume. `owner` in particular did not exist
      // before: the panel fell back to the PARCEL's owner, so every flat in
      // the tower was attributed to the developer.
      owner: OWNERS[`${lvl}-${slotNo}`] ?? 'Unallotted',
      address: `Flat ${code}, ${BUILDING_NAME}, ${STREET}, ${CITY} ${PIN}`,
      facing: slot.facing,
      ring: { type: 'Polygon', coordinates: flatRing(slot) },
    });
    unitCounter++;
  });
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
// COUNTED, not incremented. The previous version added a fixed delta on every
// run, so a second run silently double-counted the one building it had already
// added -- which is exactly what happened, and left the gallery claiming 386
// buildings against a file holding 385. Recomputing from the snapshots that
// were just written makes the script idempotent and makes the stats true by
// construction rather than by arithmetic nobody re-checks.
for (const p of projectsDoc.projects ?? []) {
  if (p.slug !== SLUG) continue;
  p.stats = {
    ...p.stats,
    buildings: buildings.features.length,
    parcels: parcels.features.length,
    utilities: utilities.features.length,
    floors: Object.values(detail).reduce((n, d) => n + (d.floors?.length ?? 0), 0),
    units: Object.values(detail).reduce((n, d) => n + (d.units?.length ?? 0), 0),
  };
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
console.log(`  ${units.length} flats: 4 per floor on floors ${FLAT_FLOORS.join(', ')}`);
console.log(`  each ${builtM2} m² built-up / ${carpetM2} m² carpet`);
console.log('  3 basements (B1, B2, B3)');
console.log('  1 water riser, 1 sewer lateral, 1 sewer tank');
console.log('Snapshot files updated.');
