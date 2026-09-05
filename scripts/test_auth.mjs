// scripts/test_auth.mjs
//
// Functional test of the auth foundation -- session encode/decode,
// role-aware building access, and a dry-run of the citizen filter
// applied to a real building document.
//
// USAGE:
//   npm run auth:test
//
// The script does NOT spin up Next.js or start a dev server. It loads
// the auth modules directly via the dynamic-import trick that
// scripts/test_cache.mjs established, and exercises the pure parts:
//   - encode/decode round trip
//   - role discrimination (citizen vs gov)
//   - checkBuildingAccess on a not-yours id
//   - the citizen filter on a real buildings.json FeatureCollection
//
// What is NOT tested here is the route handlers themselves -- those
// need a running server and are covered by the Playwright probe.

process.env.SESSION_SECRET = process.env.SESSION_SECRET
  ?? 'test-secret-do-not-use-in-prod-12345678';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const { encodeSession, decodeSession, makeCitizenSession, makeGovSession,
  _resetForTests, buildSetCookie, buildClearCookie } =
  await import('../lib/auth/session.ts');
const { checkBuildingAccess, checkMutation, checkProjectAccess,
  isMutator, ownsUnit, filterDetailForCaller, callerContext: _cc } =
  await import('../lib/auth/access-pure.ts');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => { _resetForTests(); return fn(); })
    .then(() => { console.log(`  ok  ${name}`); pass++; })
    .catch((e) => { console.log(`  not ok  ${name}\n         ${e.stack || e.message}`); fail++; });
}

console.log('Auth foundation tests:\n');

// ---- session round trip ----------------------------------------------------
await test('encodeSession + decodeSession: round trip', () => {
  const claims = makeCitizenSession({
    aadhar: '111122223333',
    name: 'Ravi Kumar',
    slug: 'siripuram',
    buildingId: 999,
    floor: 2,
    unit: 'F-1',
  });
  const token = encodeSession(claims);
  const parsed = decodeSession(token);
  assert.ok(parsed, 'decode should yield a claims object');
  assert.equal(parsed.role, 'citizen');
  assert.equal(parsed.sub, '111122223333');
  assert.equal(parsed.buildingId, 999);
  assert.equal(parsed.floor, 2);
  assert.equal(parsed.unit, 'F-1');
});

await test('encodeSession + decodeSession: gov claims', () => {
  const claims = makeGovSession({ email: 'admin@sampath.gov.in', name: 'admin' });
  const token = encodeSession(claims);
  const parsed = decodeSession(token);
  assert.ok(parsed, 'decode should yield a claims object');
  assert.equal(parsed.role, 'gov');
  assert.equal(parsed.sub, 'admin@sampath.gov.in');
});

await test('decodeSession: tampered signature returns null', () => {
  const claims = makeGovSession({ email: 'a@b.com', name: 'a' });
  const token = encodeSession(claims);
  // Flip a byte in the signature half.
  const dot = token.lastIndexOf('.');
  const tampered = token.slice(0, dot + 1) + 'AAAA' + token.slice(dot + 5);
  const parsed = decodeSession(tampered);
  assert.equal(parsed, null, 'tampered token must not decode');
});

await test('decodeSession: expired token returns null', () => {
  const claims = makeGovSession({ email: 'a@b.com', name: 'a', ttlMs: -10 });
  const token = encodeSession(claims);
  const parsed = decodeSession(token);
  assert.equal(parsed, null, 'expired token must not decode');
});

await test('decodeSession: missing token returns null', () => {
  assert.equal(decodeSession(undefined), null);
  assert.equal(decodeSession(''), null);
  assert.equal(decodeSession('not-a-token'), null);
});

// ---- cookie shape ----------------------------------------------------------
await test('buildSetCookie: HttpOnly, SameSite=Lax, Max-Age present', () => {
  const claims = makeGovSession({ email: 'a@b.com', name: 'a' });
  const cookie = buildSetCookie(claims);
  assert.ok(cookie.includes('ulpin_session='), 'should set the cookie name');
  assert.ok(cookie.includes('HttpOnly'), 'should mark HttpOnly');
  assert.ok(cookie.includes('SameSite=Lax'), 'should use SameSite=Lax');
  assert.ok(/Max-Age=\d+/.test(cookie), 'should set Max-Age');
});

await test('buildClearCookie: zeros the cookie', () => {
  const cookie = buildClearCookie();
  assert.ok(cookie.includes('ulpin_session='), 'should target the cookie name');
  assert.ok(cookie.includes('Max-Age=0'), 'should expire immediately');
});

// ---- role-aware access -----------------------------------------------------
const mkRes = (status) => ({ status, headers: new Map() });

await test('checkBuildingAccess: anon passes', () => {
  const r = checkBuildingAccess({ kind: 'anon' }, 'siripuram', 999);
  assert.equal(r, null);
});

await test('checkBuildingAccess: gov passes', () => {
  const r = checkBuildingAccess({ kind: 'gov' }, 'siripuram', 999);
  assert.equal(r, null);
});

await test('checkBuildingAccess: citizen on their own building passes', () => {
  const r = checkBuildingAccess(
    { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' },
    'siripuram', 999,
  );
  assert.equal(r, null);
});

await test('checkBuildingAccess: citizen on a different building is 404', () => {
  const r = checkBuildingAccess(
    { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' },
    'siripuram', 193,
  );
  assert.ok(r, 'expected a 404 response');
  assert.equal(r.status, 404, 'must be 404 not 403, to avoid leaking which ids exist');
});

await test('checkProjectAccess: citizen on a different project is 404', () => {
  const r = checkProjectAccess(
    { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' },
    'hyderabad-banjara',
  );
  assert.ok(r, 'expected a 404 response');
  assert.equal(r.status, 404);
});

await test('isMutator: only gov can mutate', () => {
  assert.equal(isMutator({ kind: 'gov' }), true);
  assert.equal(isMutator({ kind: 'citizen', slug: 'a', buildingId: 1, floor: 1, unit: '101' }), false);
  assert.equal(isMutator({ kind: 'anon' }), false);
});

await test('checkMutation: citizen gets 403, anon gets 401', () => {
  const citizen = checkMutation({ kind: 'citizen', slug: 'a', buildingId: 1, floor: 1, unit: '101' });
  assert.equal(citizen.status, 403);
  const anon = checkMutation({ kind: 'anon' });
  assert.equal(anon.status, 401);
  assert.equal(checkMutation({ kind: 'gov' }), null);
});

// ---- citizen filter on the real buildings snapshot -------------------------
await test('Citizen buildings filter keeps only the matching id', async () => {
  const raw = await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'buildings.json'),
    'utf-8',
  );
  const fc = JSON.parse(raw);
  const before = fc.features.length;
  const filtered = {
    ...fc,
    features: fc.features.filter((f) => f.properties.id === 999),
  };
  const after = filtered.features.length;
  assert.ok(after === 1, `expected 1 building after filter, got ${after}`);
  assert.ok(filtered.features[0].properties.id === 999);
  // Sanity: 999 is a real entry; before the seed script it would be 0.
  assert.ok(before > after, 'snapshot must include more than the one citizen building');
});

// ---- unit-level filtering on the real detail snapshot ----------------------
const RAVI = { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' };

await test('ownsUnit: matches on (level, code), not on id', () => {
  assert.equal(ownsUnit(RAVI, { level_no: 2, unit_no: '201' }), true);
  // Same code on another floor, and another code on the same floor.
  assert.equal(ownsUnit(RAVI, { level_no: 5, unit_no: '201' }), false);
  assert.equal(ownsUnit(RAVI, { level_no: 2, unit_no: '202' }), false);
  // Gov and anon are not narrowed to a flat at all.
  assert.equal(ownsUnit({ kind: 'gov' }, { level_no: 9, unit_no: '903' }), true);
  assert.equal(ownsUnit({ kind: 'anon' }, { level_no: 9, unit_no: '903' }), true);
});

await test('filterDetailForCaller: a citizen keeps every flat, but only one is readable', async () => {
  const raw = await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'),
    'utf-8',
  );
  const detail = JSON.parse(raw)['999'];
  assert.ok(detail, 'building 999 must exist in the snapshot');
  assert.ok(detail.units.length > 1, 'the demo tower must hold more than one flat');

  const mine = filterDetailForCaller(RAVI, detail);
  // Every flat is still there -- the citizen can see their whole building.
  assert.equal(mine.units.length, detail.units.length);
  // The floors survive too: the flat is shown inside a real building.
  assert.equal(mine.floors.length, detail.floors.length);

  const own = mine.units.filter((u) => !u.restricted);
  assert.equal(own.length, 1, `expected 1 readable flat, got ${own.length}`);
  assert.equal(own[0].unit_no, '201');
  assert.equal(own[0].owner, 'Ravi Kumar');
  assert.ok(own[0].ulpin, 'the citizen keeps their own ULPIN');

  // Every other flat keeps its shape and loses its register entry.
  for (const u of mine.units.filter((x) => x.restricted)) {
    assert.ok(u.ring, `flat ${u.unit_no} must keep its geometry`);
    assert.ok(typeof u.level_no === 'number', 'and its level');
    for (const field of ['ulpin', 'owner', 'address', 'carpet_m2',
      'built_m2', 'tenure', 'encumbrance', 'facing']) {
      assert.equal(u[field], undefined,
        `restricted flat ${u.unit_no} must not carry ${field}`);
    }
  }

  // Belt and braces: no neighbour's ULPIN survives anywhere in the payload.
  const serialised = JSON.stringify(mine);
  for (const code of ['202', '203', '204', '502', '903']) {
    assert.ok(
      !serialised.includes(`-${code}"`),
      `neighbour flat ${code}'s ULPIN must not appear in a citizen's document`,
    );
  }
  // Nor any neighbour's name.
  for (const name of ['Meena Patnaik', 'Joseph Fernandes', 'Sanjay Varma']) {
    assert.ok(!serialised.includes(name), `${name} must not appear`);
  }
});

await test('filterDetailForCaller: gov keeps every flat', async () => {
  const raw = await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'),
    'utf-8',
  );
  const detail = JSON.parse(raw)['999'];
  const all = filterDetailForCaller({ kind: 'gov' }, detail);
  assert.equal(all.units.length, detail.units.length);
});

await test('Every flat carries owner and address', async () => {
  const raw = await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'),
    'utf-8',
  );
  const detail = JSON.parse(raw)['999'];
  for (const u of detail.units) {
    assert.ok(u.owner, `flat ${u.unit_no} has no owner`);
    assert.ok(u.address?.includes(u.unit_no), `flat ${u.unit_no} has no matching address`);
  }
  // Four flats per residential floor, each with its own footprint.
  const byLevel = new Map();
  for (const u of detail.units) {
    byLevel.set(u.level_no, (byLevel.get(u.level_no) ?? 0) + 1);
  }
  for (const [level, n] of byLevel) {
    assert.equal(n, 4, `level ${level} has ${n} flats, expected 4`);
  }
  const rings = new Set(detail.units
    .filter((u) => u.level_no === 2)
    .map((u) => JSON.stringify(u.ring)));
  assert.equal(rings.size, 4, 'the four flats on a floor must have distinct footprints');
});

// ---- the residents roster must match the flats that exist ------------------
await test('Every demo login points at a flat that exists', async () => {
  const residents = JSON.parse(await fs.readFile(
    path.join(process.cwd(), 'data', 'projects', 'siripuram', 'residents.json'),
    'utf-8',
  ));
  const detail = JSON.parse(await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'),
    'utf-8',
  ));
  for (const r of residents) {
    const doc = detail[String(r.building_id)];
    assert.ok(doc, `resident ${r.name} points at missing building ${r.building_id}`);
    const unit = doc.units.find(
      (u) => u.level_no === r.floor && u.unit_no === r.unit,
    );
    assert.ok(unit, `resident ${r.name} points at missing flat ${r.unit} on floor ${r.floor}`);
    // The roster name and the flat's owner are the same person, or the
    // citizen would sign in and find someone else's name on their own flat.
    assert.equal(unit.owner, r.name, `flat ${r.unit} owner disagrees with the roster`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
