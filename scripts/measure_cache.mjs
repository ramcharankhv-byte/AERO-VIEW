// scripts/measure_cache.mjs
//
// Cold vs warm timings for the two cacheable endpoints, run with the
// in-process shim so the timings reflect the cache layer's savings
// without needing a real Redis.
//
// USAGE:
//   npm run cache:measure
//
// Output is written to stdout as a small table -- this is meant to be
// read by the operator, not parsed.

// See test_cache.mjs for why this is set unconditionally.
process.env.ULPIN_REDIS_URL = process.env.ULPIN_REDIS_URL ?? 'redis://localhost:6379';

import { performance } from 'node:perf_hooks';

const { _resetForTests: resetRedis } = await import('../lib/cache/redis.ts');
const { cachedConflicts, cachedQueryPoint } = await import('../lib/cache/store.ts');

const ITER = 20;
const PROJECTS = ['siripuram', 'hyderabad-banjara'];

/** Stable query coordinates: a click in the middle of siripuram, the
 *  same as scripts/test_cache.mjs uses. */
const QUERY_LON = 83.30;
const QUERY_LAT = 17.72;
const QUERY_Z = 10;

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

async function timeOne(label, fn) {
  const t = performance.now();
  const r = await fn();
  const ms = performance.now() - t;
  return { label, ms, cache: r.cache };
}

async function measurePair(label, fn) {
  resetRedis();
  const cold = await timeOne(label, fn);
  const warm = await timeOne(label, fn);
  return { cold: cold.ms, warm: warm.ms, coldStatus: cold.cache, warmStatus: warm.cache };
}

async function measureN(label, fn, n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(await measurePair(label, fn));
  const cold = rows.map((r) => r.cold).sort((a, b) => a - b);
  const warm = rows.map((r) => r.warm).sort((a, b) => a - b);
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  return {
    n,
    cold: {
      min: cold[0],
      p50: percentile(cold, 50),
      p90: percentile(cold, 90),
      mean: sum(cold) / cold.length,
    },
    warm: {
      min: warm[0],
      p50: percentile(warm, 50),
      p90: percentile(warm, 90),
      mean: sum(warm) / warm.length,
    },
    coldStatus: rows[0].coldStatus,
    warmStatus: rows[0].warmStatus,
  };
}

function fmt(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n < 0.01) return `${(n * 1000).toFixed(1)}us`;
  if (n < 1) return `${(n * 1000).toFixed(1)}us`;
  if (n < 10) return `${n.toFixed(2)}ms`;
  return `${n.toFixed(1)}ms`;
}

function speedup(c, w) {
  if (!Number.isFinite(w) || w === 0) return 'n/a';
  return `${(c / w).toFixed(1)}x`;
}

const sections = [];

for (const slug of PROJECTS) {
  console.log(`\n[${slug}] conflicts (cachedConflicts)`);
  const c = await measureN('conflicts', () => cachedConflicts(slug), ITER);
  console.log(`  cold (${c.coldStatus}): min ${fmt(c.cold.min)}  p50 ${fmt(c.cold.p50)}  p90 ${fmt(c.cold.p90)}  mean ${fmt(c.cold.mean)}  (n=${c.n})`);
  console.log(`  warm (${c.warmStatus}): min ${fmt(c.warm.min)}  p50 ${fmt(c.warm.p50)}  p90 ${fmt(c.warm.p90)}  mean ${fmt(c.warm.mean)}`);
  console.log(`  speedup: ${speedup(c.cold.p50, c.warm.p50)} (cold p50 / warm p50)`);
  sections.push({ kind: 'conflicts', slug, ...c });

  console.log(`\n[${slug}] point query (cachedQueryPoint ${QUERY_LON}, ${QUERY_LAT}, ${QUERY_Z})`);
  const q = await measureN('query', () => cachedQueryPoint(slug, QUERY_LON, QUERY_LAT, QUERY_Z), ITER);
  console.log(`  cold (${q.coldStatus}): min ${fmt(q.cold.min)}  p50 ${fmt(q.cold.p50)}  p90 ${fmt(q.cold.p90)}  mean ${fmt(q.cold.mean)}  (n=${q.n})`);
  console.log(`  warm (${q.warmStatus}): min ${fmt(q.warm.min)}  p50 ${fmt(q.warm.p50)}  p90 ${fmt(q.warm.p90)}  mean ${fmt(q.warm.mean)}`);
  console.log(`  speedup: ${speedup(q.cold.p50, q.warm.p50)} (cold p50 / warm p50)`);
  sections.push({ kind: 'query', slug, ...q });
}

console.log('\n-- summary --');
for (const s of sections) {
  const tag = s.kind === 'conflicts' ? 'conflicts      ' : 'point query    ';
  console.log(`${tag} ${s.slug.padEnd(18)} cold p50 ${fmt(s.cold.p50).padStart(8)}  warm p50 ${fmt(s.warm.p50).padStart(8)}  speedup ${speedup(s.cold.p50, s.warm.p50)}`);
}
