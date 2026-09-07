/**
 * node --test lib/survey-parcel.test.ts
 *
 * The two guarantees scripts/survey_parcels.sql makes about the layer it
 * builds, asserted against the EXPORTED artefact rather than against the SQL:
 *
 *   1. No parcel crosses a road. Every polygon in survey_parcels.json clears
 *      every street centreline in roads.json by half that street's class
 *      width.
 *   2. Every building is on a parcel. Every footprint in buildings.json is
 *      claimed by exactly one survey parcel.
 *
 * Plus the thing that makes (1) meaningful: the corridor widths in
 * lib/roads/corridors.ts and the VALUES list in scripts/survey_parcels.sql are
 * the same numbers. They have to be stated twice -- PostGIS cannot import a
 * TypeScript module and this test cannot ask PostGIS -- so the pair is
 * asserted, the way lib/ulpin.test.ts asserts ulpin.ts against ulpin_fmt().
 *
 * READS THE COMMITTED SNAPSHOT, unlike the other four test files here, which
 * synthesise their geometry. That is the point: these are properties of the
 * data that shipped, not of an algorithm, and a synthetic parcel would assert
 * that the test can construct a valid one rather than that the pipeline did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROAD_CORRIDOR_M, SLIVER_MIN_SQM, roadHalfWidthM } from './roads/corridors.ts';

const ROOT = process.cwd();
const API = path.join(ROOT, 'data', 'api', 'siripuram');

const read = (name: string) =>
  JSON.parse(readFileSync(path.join(API, name), 'utf-8'));

const parcels = read('survey_parcels.json');
const roads = read('roads.json');
const buildings = read('buildings.json');

/**
 * Tolerance on the clearance test, metres.
 *
 * ST_Buffer approximates a circle with 8 segments per quadrant by default, so
 * the buffer polygon is INSCRIBED in the true buffer -- it cuts back very
 * slightly less than the nominal half-width near a line end or a join. The
 * worst-case shortfall is r*(1-cos(pi/32)), which is 5.8 cm on the widest
 * corridor here. Geometry is also exported at 7 decimal places, another
 * centimetre. 30 cm covers both with room to spare and is still two orders of
 * magnitude tighter than the thing being tested: a parcel that crossed a road
 * would be metres inside it, not centimetres.
 */
const CLEARANCE_TOLERANCE_M = 0.3;

// ---------------------------------------------------------------------------
// A local metric plane at the AOI centre. Equirectangular is accurate to well
// under a metre over a bounding box 1.2 km across, which is the same
// approximation lib/geo.test.ts and scripts/project.py both use.
// ---------------------------------------------------------------------------
const LAT0 = 17.723;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const LON0 = 83.31875;

type P = { x: number; y: number };
const toM = (lon: number, lat: number): P => ({
  x: (lon - LON0) * M_PER_DEG_LON,
  y: (lat - LAT0) * M_PER_DEG_LAT,
});

/** Shortest distance from p to segment ab, metres. */
function pointSegDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0
    ? 0
    : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Do segments ab and cd properly intersect? */
function segsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) =>
    Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/** Every (segment, half-width) the corridor rule covers, in metres. */
function roadSegments(): { a: P; b: P; half: number }[] {
  const out: { a: P; b: P; half: number }[] = [];
  for (const f of roads.features) {
    const half = roadHalfWidthM(f.properties.cls);
    // A class this layer does not treat as a street contributes no corridor,
    // and the SQL drops it the same way with an inner join.
    if (half === null) continue;
    const parts: number[][][] = f.geometry.type === 'MultiLineString'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    for (const line of parts) {
      for (let i = 0; i < line.length - 1; i++) {
        out.push({
          a: toM(line[i][0], line[i][1]),
          b: toM(line[i + 1][0], line[i + 1][1]),
          half,
        });
      }
    }
  }
  return out;
}

/**
 * A coarse uniform grid over the road segments.
 *
 * Without it this is 10k parcel edges against 3k road segments, which is 30
 * million pair tests in a unit test suite that runs on every commit. With it,
 * each parcel only sees the segments in the cells its bounding box touches.
 */
const CELL_M = 60;
function indexRoads(segs: ReturnType<typeof roadSegments>) {
  const cells = new Map<string, number[]>();
  const key = (i: number, j: number) => `${i},${j}`;
  segs.forEach((s, idx) => {
    const maxHalf = Math.max(...Object.values(ROAD_CORRIDOR_M)) / 2;
    const i0 = Math.floor((Math.min(s.a.x, s.b.x) - maxHalf) / CELL_M);
    const i1 = Math.floor((Math.max(s.a.x, s.b.x) + maxHalf) / CELL_M);
    const j0 = Math.floor((Math.min(s.a.y, s.b.y) - maxHalf) / CELL_M);
    const j1 = Math.floor((Math.max(s.a.y, s.b.y) + maxHalf) / CELL_M);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        const list = cells.get(k);
        if (list) list.push(idx);
        else cells.set(k, [idx]);
      }
    }
  });
  return (pts: P[]) => {
    const hit = new Set<number>();
    let minX = Infinity; let minY = Infinity;
    let maxX = -Infinity; let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    for (let i = Math.floor(minX / CELL_M); i <= Math.floor(maxX / CELL_M); i++) {
      for (let j = Math.floor(minY / CELL_M); j <= Math.floor(maxY / CELL_M); j++) {
        for (const idx of cells.get(key(i, j)) ?? []) hit.add(idx);
      }
    }
    return [...hit].map((idx) => segs[idx]);
  };
}

// ---------------------------------------------------------------------------

test('the corridor widths in the SQL and in TypeScript are the same numbers', () => {
  const sql = readFileSync(
    path.join(ROOT, 'scripts', 'survey_parcels.sql'), 'utf-8',
  );
  // The VALUES list that scripts/survey_parcels.sql buffers by: rows of
  // ('class', width). Read out of the file rather than restated here, so this
  // asserts the pair and not a third copy of the numbers.
  const found = new Map<string, number>();
  for (const m of sql.matchAll(/\('([a-z_]+)',\s*([0-9]+(?:\.[0-9]+)?)\)/g)) {
    found.set(m[1], Number(m[2]));
  }
  assert.deepEqual(
    Object.fromEntries([...found].sort()),
    Object.fromEntries(Object.entries(ROAD_CORRIDOR_M).sort()),
    'scripts/survey_parcels.sql and lib/roads/corridors.ts have drifted apart',
  );
});

test('every survey parcel carries a 4-digit label and a positive extent', () => {
  assert.ok(parcels.features.length > 0, 'no survey parcels were exported');
  const labels = new Set<string>();
  for (const f of parcels.features) {
    const p = f.properties;
    assert.match(p.label, /^\d{4}$/, `label ${p.label} is not 4 digits`);
    assert.ok(!labels.has(p.label), `label ${p.label} appears twice`);
    labels.add(p.label);
    assert.ok(p.extent_sqm > 0, `parcel ${p.label} has no extent`);
    assert.equal(f.geometry.type, 'Polygon');
  }
});

test('a derived parcel carries no survey number', () => {
  for (const f of parcels.features) {
    const p = f.properties;
    if (p.provenance !== 'derived') continue;
    assert.equal(p.ts_no, null, `parcel ${p.label} carries a TS number`);
    assert.equal(p.lpm_no, null, `parcel ${p.label} carries an LPM number`);
    assert.equal(p.ulpin_14, null, `parcel ${p.label} carries a Bhu-Aadhaar`);
    assert.equal(p.source, null, `parcel ${p.label} names a source`);
  }
});

test('no parcel polygon intersects a road corridor', () => {
  const segs = roadSegments();
  assert.ok(segs.length > 0, 'roads.json yielded no corridor segments');
  const near = indexRoads(segs);

  const failures: string[] = [];
  for (const f of parcels.features) {
    const ring: number[][] = f.geometry.coordinates[0];
    const pts = ring.map(([lon, lat]) => toM(lon, lat));
    const candidates = near(pts);

    for (const s of candidates) {
      // 1. Clearance: no vertex of the parcel is inside the corridor.
      for (const p of pts) {
        const d = pointSegDist(p, s.a, s.b);
        if (d < s.half - CLEARANCE_TOLERANCE_M) {
          failures.push(
            `parcel ${f.properties.label}: vertex ${d.toFixed(2)} m from a `
            + `centreline whose corridor is ${s.half.toFixed(1)} m wide`,
          );
        }
      }
      // 2. Crossing: no parcel EDGE crosses a centreline. A parcel straddling
      //    a road with its vertices on either side clears every vertex test
      //    and is exactly the failure this layer exists to prevent.
      for (let i = 0; i < pts.length - 1; i++) {
        if (segsCross(pts[i], pts[i + 1], s.a, s.b)) {
          failures.push(
            `parcel ${f.properties.label}: an edge crosses a centreline`,
          );
        }
      }
    }
  }
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} violation(s)`);
});

test('no parcel survives under the sliver threshold without a reason', () => {
  // Slivers dissolve into their largest neighbour. A parcel below the
  // threshold is allowed to remain ONLY when it had no neighbour to merge
  // into, so this asserts the count is small rather than zero -- an isolated
  // fragment between two roads is real land and deleting it would lose it.
  const slivers = parcels.features.filter(
    (f: { properties: { extent_sqm: number } }) =>
      f.properties.extent_sqm < SLIVER_MIN_SQM,
  );
  assert.ok(
    slivers.length <= parcels.features.length * 0.02,
    `${slivers.length} of ${parcels.features.length} parcels are under `
    + `${SLIVER_MIN_SQM} m2; the dissolve pass is not doing its job`,
  );
});

test('every building with a footprint is on exactly one survey parcel', () => {
  const claimed = new Map<number, string[]>();
  for (const f of parcels.features) {
    for (const id of f.properties.building_ids ?? []) {
      const list = claimed.get(id);
      if (list) list.push(f.properties.label);
      else claimed.set(id, [f.properties.label]);
    }
  }

  const unplaced: number[] = [];
  const doubled: string[] = [];
  for (const f of buildings.features) {
    const id = f.properties.id;
    if (!f.geometry || f.geometry.type !== 'Polygon') continue;
    const on = claimed.get(id);
    if (!on) unplaced.push(id);
    else if (on.length > 1) doubled.push(`${id} -> ${on.join(', ')}`);
  }

  assert.deepEqual(unplaced.slice(0, 8), [],
    `${unplaced.length} building(s) have no survey_parcel_id`);
  assert.deepEqual(doubled.slice(0, 8), [],
    `${doubled.length} building(s) are claimed by more than one parcel`);
});
