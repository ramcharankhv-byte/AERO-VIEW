/**
 * Floor-view geometry tests.
 *
 * Run with:  node --test lib/geo.test.ts
 * (Node strips the type annotations natively; there is no build step.)
 *
 * These pin the two transforms the floor view depends on and that nothing else
 * can check: the inset that gives adjacent flats a visible seam, and the
 * half-plane cut that opens them in section. Both are pure -- they take lon/lat
 * rings and return lon/lat rings -- which is exactly why they live in geo.ts
 * rather than inside a layer that needs a WebGL context to run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipRingToHalfPlane, insetRing, ringCentroid, slicePlane,
} from './geo.ts';

// Siripuram, so the longitude scaling is the one the app actually uses.
const LAT = 17.723;
const LON = 83.31875;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180);

/** A closed, counter-clockwise rectangle `w` x `h` metres centred on the AOI. */
function rect(w: number, h: number, dxM = 0, dyM = 0): number[][] {
  const x = (m: number) => LON + (m + dxM) / M_PER_DEG_LON;
  const y = (m: number) => LAT + (m + dyM) / M_PER_DEG_LAT;
  return [
    [x(-w / 2), y(-h / 2)],
    [x(w / 2), y(-h / 2)],
    [x(w / 2), y(h / 2)],
    [x(-w / 2), y(h / 2)],
    [x(-w / 2), y(-h / 2)],
  ];
}

/** Metric width and height of a ring, for asserting on an inset in metres. */
function extentM(ring: number[][]): { w: number; h: number } {
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return {
    w: (Math.max(...lons) - Math.min(...lons)) * M_PER_DEG_LON,
    h: (Math.max(...lats) - Math.min(...lats)) * M_PER_DEG_LAT,
  };
}

// ------------------------------------------------------------------ insetRing

test('insetRing shrinks every side by exactly the requested distance', () => {
  const out = insetRing(rect(10, 6), 0.12);
  const { w, h } = extentM(out);
  // Both sides move in, so each dimension loses twice the inset.
  assert.ok(Math.abs(w - (10 - 0.24)) < 1e-3, `width ${w}`);
  assert.ok(Math.abs(h - (6 - 0.24)) < 1e-3, `height ${h}`);
});

test('insetRing opens a seam of twice the inset between neighbours', () => {
  // Two flats sharing a wall at x = 0, exactly how the unit grid subdivides.
  const left = insetRing(rect(6, 6, -3), 0.12);
  const right = insetRing(rect(6, 6, 3), 0.12);
  const gapM = (Math.min(...right.map((p) => p[0]))
    - Math.max(...left.map((p) => p[0]))) * M_PER_DEG_LON;
  assert.ok(Math.abs(gapM - 0.24) < 1e-3, `seam ${gapM} m`);
});

test('insetRing keeps the ring closed, wound the same way, and centred', () => {
  const src = rect(10, 6);
  const out = insetRing(src, 0.5);
  assert.deepEqual(out[0], out[out.length - 1], 'ring must stay closed');
  assert.equal(out.length, src.length, 'no vertices gained or lost');
  const a = ringCentroid(src);
  const b = ringCentroid(out);
  assert.ok(Math.abs(a.lon - b.lon) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9);
});

test('insetRing works on a clockwise ring too', () => {
  const cw = rect(10, 6).slice(0, -1).reverse();
  cw.push([cw[0][0], cw[0][1]]);
  const { w, h } = extentM(insetRing(cw, 0.12));
  assert.ok(Math.abs(w - 9.76) < 1e-3, `width ${w}`);
  assert.ok(Math.abs(h - 5.76) < 1e-3, `height ${h}`);
});

test('insetRing handles a triangle, which is what a corner flat can be', () => {
  const t = [
    [LON, LAT],
    [LON + 8 / M_PER_DEG_LON, LAT],
    [LON, LAT + 8 / M_PER_DEG_LAT],
    [LON, LAT],
  ];
  const out = insetRing(t, 0.12);
  assert.equal(out.length, t.length);
  const { w } = extentM(out);
  assert.ok(w > 0 && w < 8, `triangle should shrink, got ${w} m`);
});

test('insetRing falls back rather than turning a too-small flat inside out', () => {
  // A 0.4 m box inset by 0.5 m would fold through itself.
  const out = insetRing(rect(0.4, 0.4), 0.5);
  const { w, h } = extentM(out);
  assert.ok(w > 0 && h > 0, 'must stay a real polygon');
  assert.ok(w < 0.4 && h < 0.4, 'and must still be smaller than the source');
});

test('insetRing is a no-op for a zero or negative distance', () => {
  const src = rect(10, 6);
  assert.deepEqual(insetRing(src, 0), src);
  assert.deepEqual(insetRing(src, -1), src);
});

test('insetRing never touches the source ring', () => {
  const src = rect(10, 6);
  const copy = JSON.parse(JSON.stringify(src));
  insetRing(src, 0.12);
  assert.deepEqual(src, copy, 'stored geometry must survive rendering');
});

// -------------------------------------------------------- slicePlane + clip

test('slicePlane at 0 offset passes through the footprint centroid', () => {
  const ring = rect(20, 12);
  const p = slicePlane(ring, 'ew', 0);
  const c = ringCentroid(ring);
  assert.ok(Math.abs(p.lon - c.lon) < 1e-9 && Math.abs(p.lat - c.lat) < 1e-9);
  assert.deepEqual([p.nx, p.ny], [1, 0]);
  assert.deepEqual(
    [slicePlane(ring, 'ns', 0).nx, slicePlane(ring, 'ns', 0).ny], [0, 1],
  );
});

test('a centred cut keeps half the ring', () => {
  const ring = rect(20, 12);
  const cut = clipRingToHalfPlane(ring, slicePlane(ring, 'ew', 0));
  const { w, h } = extentM(cut);
  assert.ok(Math.abs(w - 10) < 1e-3, `kept width ${w}`);
  assert.ok(Math.abs(h - 12) < 1e-3, `full height should survive, got ${h}`);
});

test('the cut removes everything past the plane and nothing before it', () => {
  const ring = rect(20, 12);
  assert.equal(clipRingToHalfPlane(ring, slicePlane(ring, 'ew', -100)).length, 0,
    'plane at the near edge cuts the whole ring away');
  const whole = clipRingToHalfPlane(ring, slicePlane(ring, 'ew', 100));
  assert.ok(Math.abs(extentM(whole).w - 20) < 1e-3,
    'plane at the far edge leaves the ring intact');
});

test('the cut keeps flats separate rather than merging them', () => {
  // The seam from insetRing has to survive the section, or adjacent cut flats
  // read as one slab -- which is the whole point of sectioning a floor.
  const plane = slicePlane(rect(12, 6), 'ns', 0);
  const left = clipRingToHalfPlane(insetRing(rect(6, 6, -3), 0.12), plane);
  const right = clipRingToHalfPlane(insetRing(rect(6, 6, 3), 0.12), plane);
  assert.ok(left.length >= 4 && right.length >= 4, 'both flats survive the cut');
  const gapM = (Math.min(...right.map((p) => p[0]))
    - Math.max(...left.map((p) => p[0]))) * M_PER_DEG_LON;
  assert.ok(Math.abs(gapM - 0.24) < 1e-3, `seam in section ${gapM} m`);
});

test('a cut ring comes back closed', () => {
  const ring = rect(20, 12);
  const cut = clipRingToHalfPlane(ring, slicePlane(ring, 'ns', 20));
  assert.deepEqual(cut[0], cut[cut.length - 1]);
});
