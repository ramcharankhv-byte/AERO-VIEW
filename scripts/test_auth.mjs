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
  isMutator, callerContext: _cc } =
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
    { kind: 'citizen', slug: 'siripuram', buildingId: 999 },
    'siripuram', 999,
  );
  assert.equal(r, null);
});

await test('checkBuildingAccess: citizen on a different building is 404', () => {
  const r = checkBuildingAccess(
    { kind: 'citizen', slug: 'siripuram', buildingId: 999 },
    'siripuram', 193,
  );
  assert.ok(r, 'expected a 404 response');
  assert.equal(r.status, 404, 'must be 404 not 403, to avoid leaking which ids exist');
});

await test('checkProjectAccess: citizen on a different project is 404', () => {
  const r = checkProjectAccess(
    { kind: 'citizen', slug: 'siripuram', buildingId: 999 },
    'hyderabad-banjara',
  );
  assert.ok(r, 'expected a 404 response');
  assert.equal(r.status, 404);
});

await test('isMutator: only gov can mutate', () => {
  assert.equal(isMutator({ kind: 'gov' }), true);
  assert.equal(isMutator({ kind: 'citizen', slug: 'a', buildingId: 1 }), false);
  assert.equal(isMutator({ kind: 'anon' }), false);
});

await test('checkMutation: citizen gets 403, anon gets 401', () => {
  const citizen = checkMutation({ kind: 'citizen', slug: 'a', buildingId: 1 });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
