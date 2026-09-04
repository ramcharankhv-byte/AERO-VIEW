// scripts/test_cache.mjs
//
// Direct functional test of the cache store, run as a single
// process (not via node --test, so we don't have to fight the
// worker-thread module loader).
//
// USAGE:
//   npm run cache:test
//
// The wrapper in lib/cache/redis.ts short-circuits to `null` when
// ULPIN_REDIS_URL is unset, so the shim would never be loaded. We
// set the env var to a fake URL -- the shim never connects, the
// value is a marker, not a host.

process.env.ULPIN_REDIS_URL = process.env.ULPIN_REDIS_URL ?? 'redis://localhost:6379';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const { _resetForTests: resetRedis } = await import('../lib/cache/redis.ts');
const { cachedDetail, cachedConflicts, cachedQueryPoint } = await import('../lib/cache/store.ts');
const { cacheGet } = await import('../lib/cache/redis.ts');
const { detailKey } = await import('../lib/cache/keys.ts');
const { applyEdit } = await import('../lib/data/edits.ts');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => { resetRedis(); return fn(); })
    .then(() => { console.log(`  ok  ${name}`); pass++; })
    .catch((e) => { console.log(`  not ok  ${name}\n         ${e.message}`); fail++; });
}

console.log('Cache store tests:\n');

await test('cachedDetail: first call returns a document, second is a hit', async () => {
  const r1 = await cachedDetail('siripuram', 1);
  assert.ok(r1.value, 'first call should return a document');
  assert.ok(['miss', 'bypass', 'hit'].includes(r1.cache), `unexpected cache status ${r1.cache}`);
  const r2 = await cachedDetail('siripuram', 1);
  assert.equal(r2.cache, 'hit', `expected hit, got ${r2.cache}`);
});

await test('cachedDetail: 404 is not cached', async () => {
  const r = await cachedDetail('siripuram', 999999);
  assert.equal(r.value, null);
  const key = await detailKey('siripuram', 999999);
  const v = await cacheGet(key);
  assert.equal(v, undefined, 'a 404 must not be cached');
});

await test('cachedConflicts: second call is a hit', async () => {
  const r1 = await cachedConflicts('siripuram');
  assert.ok(Array.isArray(r1.value));
  assert.ok(r1.value.length > 0, 'siripuram has conflicts in its snapshot');
  const r2 = await cachedConflicts('siripuram');
  assert.equal(r2.cache, 'hit');
  assert.deepEqual(r2.value, r1.value);
});

await test('cachedQueryPoint: second call is a hit', async () => {
  const r1 = await cachedQueryPoint('siripuram', 83.30, 17.72, 10);
  assert.ok(Array.isArray(r1.value));
  const r2 = await cachedQueryPoint('siripuram', 83.30, 17.72, 10);
  assert.equal(r2.cache, 'hit');
  assert.deepEqual(r2.value, r1.value);
});

// ---------------------------------------------------------------------------
// Rule 1: a PATCH-equivalent edit is visible on the very next read, with no
// cache-clearing anywhere on the PATCH path. This is the property that makes
// the cache "impossible to get wrong invalidation-wise": the cache holds the
// PRISTINE value, and the edit overlay runs on every read. So we:
//   1. Back up the existing edits.json
//   2. Read detail (cache miss, value stored in Redis)
//   3. applyEdit the building (the PATCH path)
//   4. Read detail again -- must be a HIT, and must include the new name
//   5. Restore the original edits.json
// ---------------------------------------------------------------------------
const EDITS_FILE = path.join(process.cwd(), 'data', 'projects', 'siripuram', 'edits.json');
const SENTINEL = `__RULE1_${Date.now()}__`;
let originalEdits = null;

await test('cachedDetail: PATCH-equivalent edit is visible on next read (Rule 1)', async () => {
  originalEdits = await fs.readFile(EDITS_FILE, 'utf-8').catch(() => null);

  const r1 = await cachedDetail('siripuram', 1);
  assert.ok(r1.value, 'first read must return a document');
  assert.equal(r1.cache, 'miss', 'first read must be a miss');
  const beforeName = r1.value.building.name;
  assert.notEqual(beforeName, SENTINEL, 'sentinel must not be the original name');

  // The PATCH path: only the edit record changes. The cache wrapper's
  // import('ioredis') is not called, no cacheSet, no cacheDel, no scan,
  // no del. Whatever Redis holds under detailKey(siripuram, 1) at this
  // moment is the value the next read will return.
  await applyEdit('siripuram', 1, { name: SENTINEL });

  const r2 = await cachedDetail('siripuram', 1);
  assert.equal(r2.cache, 'hit', 'second read must be a cache hit (no PATCH invalidation)');
  assert.equal(r2.value.building.name, SENTINEL, 'edit overlay must have applied the new name');
});

if (originalEdits !== null) {
  await fs.writeFile(EDITS_FILE, originalEdits, 'utf-8');
} else {
  await fs.unlink(EDITS_FILE).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
