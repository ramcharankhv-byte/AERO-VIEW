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
//   Patches data/api/projects.json             (recounts project stats)
//   Upserts the same building into PostGIS, when DATABASE_URL is reachable
//
// WHY IT WRITES TO POSTGIS TOO
//
// The API serves from PostGIS whenever the database answers, and falls back
// to these snapshots when it does not. This script used to write only the
// snapshots, so the demo building existed in exactly one of the two
// backends. With docker running, siripuram held 384 buildings and no 999:
// the gov view was missing Sampath Skyline entirely, and the citizen -- whose
// buildings collection is filtered to their own id -- got an EMPTY collection
// and a viewer with no buildings in it at all. The bug looked like "the
// citizen view is broken" and was really "the demo building was never in the
// database".
//
// Writing both keeps the two backends telling the same story. If the
// database is unreachable the snapshot half still runs, which is what a
// contributor without docker needs.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'data', 'api', 'siripuram');
const PROJECTS = path.join(ROOT, 'data', 'api', 'projects.json');
const REGISTER = path.join(ROOT, 'data', 'projects', 'siripuram', 'flat-register.json');

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
// Sampled from the project's CartoDEM clip at (CX, CY) with scripts/dem.py
// (EGM96 orthometric), so this building stands on the same ground as its
// neighbours now that siripuram's ground_elev is real. Re-sample if CX/CY move:
//   .gdal-env/python.exe -c "import sys; sys.path.insert(0,'scripts'); import dem, project;
//     print(dem.Sampler(project.default_project()).sample(83.3190, 17.7233))"
const GROUND_ELEV = 55.31;
const GROUND_SOURCE = 'dsm_dem';
// Derived local hazard exposure for this footprint, from scripts/hazard.py run
// over the real AOI with this building appended -- so its class is graded
// against its actual neighbours, not invented. Re-compute if CX/CY/height move.
const HAZARD = {
  flood_risk: 'high', flood_score: 0.585,
  cyclone_risk: 'moderate', cyclone_score: 0.495,
  coast_dist_m: 1118, local_relief_m: 0.0,
};
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
    ground_source: GROUND_SOURCE,
    ...HAZARD,
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

// ---------------------------------------------------------------------------
// 3a. The flat register -- ownership, charge, tax and bills.
//
// A SEPARATE record from the cadastre, written to
// data/projects/siripuram/flat-register.json and merged onto the unit rows by
// lib/db.ts on read. Not a set of unit columns, for two reasons. The cadastre
// answers "what is this volume and who holds title"; a bank's charge and last
// month's electricity bill answer something else, are owned by other
// authorities and change on a different clock. And a file both backends read
// cannot drift the way a column that only PostGIS has would -- which is the
// same split-brain that lost the demo building and still hides the citizen's
// own utility runs.
//
// Every value here is INVENTED. It is shaped like a register entry so the
// panel can be built and read honestly; the panel labels it as a
// demonstration value, and nothing in it should ever be quoted as fact.
// ---------------------------------------------------------------------------

/**
 * The three demo logins get their state chosen rather than hashed.
 *
 * Everything else in the register is deterministic from the flat code, which
 * is fine for the 21 flats nobody signs in as. It is not fine for the three
 * that are the demo: whether the panel shows a mortgage, an outstanding
 * demand or an overdue bill would then be decided by a hash, and the most
 * likely outcome is that the first login anyone tries shows the dullest
 * possible card. These three are picked to cover the states between them.
 *
 *   tax: 0 = nothing paid, 2 = part paid, 8 = paid in full
 *   arrears: the bills left unpaid
 */
const DEMO_STATES = {
  // Ravi Kumar, floor 2 -- mortgaged, tax settled, the water bill overdue.
  201: { mortgaged: true, tax: 8, arrears: ['water'] },
  // Priya Sharma, floor 5 -- owns it outright and owes nothing.
  502: { mortgaged: false, tax: 8, arrears: [] },
  // Anand Rao, floor 9 -- mortgaged, and this year's tax only half paid.
  903: { mortgaged: true, tax: 2, arrears: ['electricity'] },
};

/** Deterministic 0..n-1 from a string, so a re-run produces the same register. */
function pick(seed, n) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % n;
}

const BANKS = [
  { bank: 'State Bank of India', branch: 'Siripuram, Visakhapatnam', code: 'SBI' },
  { bank: 'HDFC Bank', branch: 'Dwaraka Nagar, Visakhapatnam', code: 'HDFC' },
  { bank: 'Union Bank of India', branch: 'Asilmetta, Visakhapatnam', code: 'UBI' },
  { bank: 'LIC Housing Finance', branch: 'Visakhapatnam', code: 'LICHFL' },
];

/** Assessment year and the billing month the demo is written against. */
const TAX_YEAR = '2026-27';
const TAX_DUE = '2026-09-30';
const BILL_PERIOD = 'Aug 2026';

/**
 * One register entry per flat.
 *
 * Two in every three flats carry a bank charge, which is about what a tower
 * of this age would look like, and the mix matters: a panel that only ever
 * renders "Owned outright" never shows the row a mortgaged owner cares about.
 * The same goes for the arrears -- a register in which everything is settled
 * would leave the overdue state untested and unseen.
 */
function registerFor(level, slotNo, code, ulpin) {
  const seed = `${SLUG}-${code}`;
  const forced = DEMO_STATES[code];
  const mortgaged = forced ? forced.mortgaged : pick(`m${seed}`, 3) !== 0;
  const b = BANKS[pick(`b${seed}`, BANKS.length)];
  const sanctioned = 3_200_000 + pick(`s${seed}`, 22) * 100_000;
  const paidOff = 0.18 + pick(`p${seed}`, 45) / 100;
  const from = 2016 + pick(`y${seed}`, 8);
  const regMonth = 1 + pick(`mm${seed}`, 12);
  const registeredOn = `${from}-${String(regMonth).padStart(2, '0')}-`
    + `${String(1 + pick(`dd${seed}`, 27)).padStart(2, '0')}`;
  // Same month as the deed, a fortnight later -- close enough to read as one
  // transaction without ever landing before it.
  const chargeFrom = `${registeredOn.slice(0, 8)}${String(
    Math.min(28, Number(registeredOn.slice(8)) + 1),
  ).padStart(2, '0')}`;

  const demand = 14_200 + pick(`t${seed}`, 40) * 200;
  // Most of the tower has settled this year's demand; a couple of flats have
  // not paid at all and one has paid part -- the three states the tax row has
  // to be able to render.
  const taxState = forced ? forced.tax : pick(`ts${seed}`, 9);
  const taxPaid = taxState < 2 ? 0 : taxState === 2 ? Math.round(demand / 2) : demand;

  const bill = (kind, authority, prefix, amount, dueDay, seedKey) => {
    const paid = forced ? !forced.arrears.includes(kind) : pick(seedKey + seed, 4) !== 0;
    return {
      kind,
      authority,
      account: `${prefix}-${pick('a' + seedKey + seed, 900000) + 100000}`,
      period: BILL_PERIOD,
      amount_inr: amount,
      paid,
      due_on: `2026-09-${String(dueDay).padStart(2, '0')}`,
      // Early in the month, so a settled bill is never dated after the day the
      // demo is set on -- a receipt from next week reads as broken data long
      // before anyone works out it is only a demo.
      paid_on: paid
        ? `2026-09-${String(1 + pick('pd' + seedKey + seed, Math.min(4, dueDay))).padStart(2, '0')}`
        : null,
    };
  };

  return {
    ulpin,
    entry: {
      ownership: mortgaged ? 'mortgaged' : 'owned',
      title_deed: `DOC/${from}/VSP/${40000 + pick(`d${seed}`, 9000)}`,
      registered_on: registeredOn,
      ...(mortgaged
        ? {
          mortgage: {
            bank: b.bank,
            branch: b.branch,
            loan_no: `${b.code}-HL-${1000000 + pick(`l${seed}`, 8999999)}`,
            sanctioned_inr: sanctioned,
            outstanding_inr: Math.round((sanctioned * (1 - paidOff)) / 100) * 100,
            emi_inr: Math.round((sanctioned / 240) * 1.55 / 10) * 10,
            // The charge is created when the sale is registered, never before
            // it: a mortgage dated ahead of the deed is not a thing a register
            // can hold, and it is the kind of detail a reader checks first.
            charge_from: chargeFrom,
            closes_on: `${from + 20}${chargeFrom.slice(4)}`,
          },
        }
        : {}),
      tax: {
        authority: 'Greater Visakhapatnam Municipal Corporation',
        assessment_no: `GVMC/50/${1100 + level}/${code}`,
        year: TAX_YEAR,
        demand_inr: demand,
        paid_inr: taxPaid,
        paid_on: taxPaid > 0
          ? `2026-0${4 + pick(`tp${seed}`, 5)}-${String(1 + pick(`td${seed}`, 27)).padStart(2, '0')}`
          : null,
        due_on: TAX_DUE,
      },
      bills: [
        bill('water', 'GVMC Water Supply', 'GVMC-W', 380 + pick(`w${seed}`, 24) * 20, 12, 'w'),
        bill('electricity', 'APEPDCL', 'APEPDCL', 1_180 + pick(`e${seed}`, 60) * 30, 18, 'e'),
        bill('maintenance', `${BUILDING_NAME} Owners' Association`, 'SSOA', 3_500, 5, 'x'),
      ],
    },
  };
}

/** ULPIN -> register entry, written to data/projects/siripuram/. */
const flatRegister = {};

const units = [];
let unitCounter = 0;
for (const lvl of FLAT_FLOORS) {
  const floorEntry = floors.find((f) => f.level_no === lvl);
  if (!floorEntry) continue;
  FLAT_SLOTS.forEach((slot, idx) => {
    const slotNo = idx + 1;
    const code = flatCode(lvl, slotNo);
    const ulpin = `${floorEntry.ulpin}-${code}`;
    const reg = registerFor(lvl, slotNo, code, ulpin);
    flatRegister[reg.ulpin] = reg.entry;
    units.push({
      id: unitIdBase + unitCounter,
      floor_id: floorEntry.id,
      ulpin,
      unit_no: code,
      level_no: lvl,
      z_min: floorEntry.z_min,
      z_max: floorEntry.z_max,
      carpet_m2: carpetM2,
      built_m2: builtM2,
      tenure: 'Freehold',
      // The cadastre's own encumbrance column, kept in step with the register
      // rather than hardcoded to 'None'. A flat with a bank's charge on it
      // that reads "Encumbrance: None" is a wrong answer stated as a right
      // one -- the same defect the owner fallback used to have.
      encumbrance: reg.entry.mortgage
        ? `Mortgage · ${reg.entry.mortgage.bank}`
        : 'None',
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
// The register is this script's own file, not a snapshot it patches, so it is
// written whole and pretty-printed -- it is meant to be read and edited by
// hand when the demo needs a different story.
await fs.writeFile(REGISTER, JSON.stringify(flatRegister, null, 2) + '\n', 'utf-8');

const mortgaged = Object.values(flatRegister).filter((e) => e.mortgage).length;
const taxDue = Object.values(flatRegister)
  .filter((e) => (e.tax?.paid_inr ?? 0) < (e.tax?.demand_inr ?? 0)).length;

console.log('Seeded building 999:');
console.log(`  ${units.length} flats: 4 per floor on floors ${FLAT_FLOORS.join(', ')}`);
console.log(`  flat register: ${mortgaged} mortgaged, ${taxDue} with tax outstanding`);
console.log(`  each ${builtM2} m² built-up / ${carpetM2} m² carpet`);
console.log('  3 basements (B1, B2, B3)');
console.log('  1 water riser, 1 sewer lateral, 1 sewer tank');
console.log('Snapshot files updated.');

// ---------------------------------------------------------------------------
// 6. PostGIS -- the same building, so both backends agree.
// ---------------------------------------------------------------------------
await seedPostgis();

async function seedPostgis() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('PostGIS: DATABASE_URL unset, snapshot only.');
    return;
  }
  let Client;
  try {
    ({ Client } = await import('pg'));
  } catch {
    console.log('PostGIS: `pg` not installed, snapshot only.');
    return;
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    // Not an error: a contributor without docker still gets the snapshots,
    // and the API falls back to them anyway.
    console.log(`PostGIS: unreachable (${err.message.split('\n')[0]}), snapshot only.`);
    return;
  }

  const ring2d = (ring) =>
    `SRID=4326;POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(',')}))`;

  try {
    const { rows } = await client.query(
      'SELECT id FROM projects WHERE slug = $1', [SLUG],
    );
    if (!rows.length) {
      console.log(`PostGIS: project ${SLUG} not seeded, skipping.`);
      return;
    }
    const projectId = rows[0].id;

    await client.query('BEGIN');
    // The new nullable columns, added to db/01_schema.sql. Applied here too so
    // an existing volume does not have to be dropped and re-seeded.
    await client.query(`
      ALTER TABLE unit ADD COLUMN IF NOT EXISTS owner text,
                       ADD COLUMN IF NOT EXISTS address text,
                       ADD COLUMN IF NOT EXISTS facing text`);

    // Delete first, in dependency order. floor/unit cascade from building.
    await client.query('DELETE FROM building WHERE id = $1', [BUILDING_ID]);
    await client.query('DELETE FROM parcel WHERE id = $1', [PARCEL_ID]);
    await client.query('DELETE FROM utility WHERE id = ANY($1)', [[99001, 99002, 99003]]);

    await client.query(
      `INSERT INTO parcel (id, ulpin, geom, area_m2, owner, project_id)
       VALUES ($1,$2,ST_GeomFromEWKT($3),$4,$5,$6)`,
      [PARCEL_ID, newParcel.properties.ulpin, ring2d(footprintRing),
        newParcel.properties.area_m2, newParcel.properties.owner, projectId],
    );

    const bp = newBuilding.properties;
    await client.query(
      `INSERT INTO building (id, parcel_id, ulpin, footprint, height_m, floors,
                             basements, ground_elev, use_type, height_source,
                             survey_synthetic, osm_id, name, address, project_id,
                             ground_source, flood_risk, cyclone_risk,
                             flood_score, cyclone_score, coast_dist_m,
                             local_relief_m)
       VALUES ($1,$2,$3,ST_GeomFromEWKT($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22)`,
      [BUILDING_ID, PARCEL_ID, bp.ulpin, ring2d(footprintRing), bp.height_m,
        bp.floors, bp.basements, bp.ground_elev, bp.use_type, bp.height_source,
        bp.survey_synthetic, bp.osm_id, bp.name, bp.address, projectId,
        bp.ground_source, bp.flood_risk, bp.cyclone_risk, bp.flood_score,
        bp.cyclone_score, bp.coast_dist_m, bp.local_relief_m],
    );

    for (const f of floors) {
      await client.query(
        // floor.geom is a PolyhedralSurfaceZ too: a storey is the solid
        // between its two heights, not a flat plate.
        `INSERT INTO floor (id, building_id, ulpin, level_no, z_min, z_max,
                            geom, detect_source)
         VALUES ($1,$2,$3,$4,$5,$6,make_prism(ST_GeomFromEWKT($7),$5,$6),$8)`,
        [f.id, BUILDING_ID, f.ulpin, f.level_no, f.z_min, f.z_max,
          ring2d(footprintRing), f.detect_source],
      );
    }

    for (const u of units) {
      // geom_3d is a PolyhedralSurfaceZ. make_prism() in db/02_functions.sql
      // is the project's own extruder -- written by hand precisely because
      // ST_Extrude needs SFCGAL, which this image does not carry -- and it is
      // what seed.py uses for every other unit. Using it here means the demo
      // flats are the same kind of solid as the rest of the cadastre, so the
      // 3D conflict tests treat them identically.
      await client.query(
        `INSERT INTO unit (id, floor_id, ulpin, unit_no, geom_3d, z_min, z_max,
                           carpet_m2, built_m2, tenure, encumbrance,
                           owner, address, facing)
         VALUES ($1,$2,$3,$4,
                 make_prism(ST_GeomFromEWKT($5), $6, $7),
                 $6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [u.id, u.floor_id, u.ulpin, u.unit_no,
          ring2d(u.ring.coordinates[0]), u.z_min, u.z_max,
          u.carpet_m2, u.built_m2, u.tenure, u.encumbrance,
          u.owner, u.address, u.facing],
      );
    }

    for (const f of [waterRiser, sewerLateral, sewerTank]) {
      const p = f.properties;
      const ewkt = `SRID=4326;LINESTRING Z(${
        f.geometry.coordinates.map(([x, y, z]) => `${x} ${y} ${z}`).join(',')})`;
      // envelope_3d stays NULL: it is the solid corridor the 3D conflict test
      // intersects against, and these three runs are internal to the building
      // and flagged in_conflict:false. The column is nullable for exactly
      // this case, and a wrong solid would be worse than no solid.
      await client.query(
        `INSERT INTO utility (id, asset_type, geom_3d, envelope_3d, depth_m,
                              radius_m, authority, status, project_id)
         VALUES ($1,$2,ST_GeomFromEWKT($3),NULL,$4,$5,$6,$7,$8)`,
        [p.id, p.asset_type, ewkt, p.depth_m, p.radius_m,
          p.authority, p.status, projectId],
      );
    }

    await client.query('COMMIT');
    console.log(`PostGIS: building ${BUILDING_ID}, ${floors.length} floors, `
      + `${units.length} flats, 3 utilities upserted.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`PostGIS: FAILED, snapshot is still correct -- ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
