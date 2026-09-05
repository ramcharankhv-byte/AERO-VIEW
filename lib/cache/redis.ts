import type Redis from 'ioredis';

/**
 * Redis client wrapper with silent degradation.
 *
 * WHY THIS LAYER EXISTS
 * ---------------------
 * The cache is an optimisation, not a dependency. A Redis container that is
 * stopped, a network that is partitioned, or a server that has never been
 * configured must all degrade to "today's behaviour" -- the in-process cache
 * already in lib/server-cache.ts, or no cache at all -- without surfacing a
 * failed request to the user. Every call into this module is therefore
 * `try { ... } catch { return bypassValue }`, and the only observable
 * difference between a Redis-served response and a directly-computed one is
 * the `x-ulpin-cache: hit|miss|bypass` header on the response.
 *
 * THE "LOG ONCE" RULE
 * -------------------
 * The brief is explicit: "logged once, never a failed request". A Redis
 * outage that lasts an hour must not produce 3,600 log lines -- one per
 * request -- because that is its own incident. The first failure flips a
 * latch; subsequent failures are silent until a successful call flips it
 * back. The first success after an outage also logs, so an operator can
 * see the recovery without having to correlate timestamps.
 *
 * THE CONNECTION MODEL
 * --------------------
 * ioredis connects lazily on first command, not on construction, and
 * auto-reconnects with exponential backoff. That means a Redis container
 * that starts AFTER the Next.js process is fine: the next command after
 * Redis is up will succeed. The wrapper holds the client as a module-level
 * singleton so all callers share one connection pool.
 *
 * `lazyConnect: true` is the important flag. Without it, `new Redis(...)`
 * would start connecting immediately, and a misconfigured REDIS_URL would
 * log an error at module-import time -- which happens on every cold start,
 * not just on first cache use.
 *
 * WHY NO REDIS = NO CLIENT
 * ------------------------
 * When `REDIS_URL` is unset, the wrapper refuses to construct a client at
 * all. A "Redis is configured but unreachable" path and a "Redis was never
 * configured" path are the same from the caller's perspective, but the
 * second one is deliberate (dev, CI, a workstation that has never had
 * Redis) and should not log the same outage line as a real incident.
 */

let client: Redis | null = null;
let clientInitFailed = false;
/** In-flight `getClient` promise. Memoised so two concurrent first-callers
 *  cannot both pass the null guards, both run the dynamic import, and both
 *  construct their own Redis instance (the second `client =` would orphan
 *  the first instance's socket and reconnect timer -- a slow connection
 *  leak under load). */
let clientPromise: Promise<Redis | null> | null = null;
/** Flipped on the first failure, cleared on the first success. */
let degraded = false;

const REDIS_URL = process.env.ULPIN_REDIS_URL ?? process.env.REDIS_URL;

/**
 * The strict allow-list for `cacheFlushPrefix`. Operators sometimes take
 * the prefix from a config field, and the brief here is "a stray `*` in
 * the prefix must not wipe the entire keyspace". Allowed characters are
 * the safe subset of what a cache key actually carries: lowercase
 * letters, digits, underscore, dash, dot, and colon. Colons are the
 * Redis convention and the only separator this module ever uses, so
 * they have to be allowed; everything else is rejected at the door.
 */
const PREFIX_ALLOW = /^[a-z0-9_.-]+$/;

/**
 * Build the ioredis client. Returns null when Redis is not configured --
 * the caller treats that the same as "unreachable" and bypasses.
 *
 * Imported lazily so the ioredis module is never loaded on a deployment
 * that has not configured Redis. That keeps the dev cold start free of
 * the package, which matters for the smoke test and for any environment
 * that runs without the cache.
 *
 * Concurrency: the dynamic import and the `new Redis(...)` call are
 * wrapped in a memoised promise. Two concurrent first-callers see the
 * same promise; only one Redis instance is ever constructed. The
 * promise is cleared in a `finally` so a later failure (network blip,
 * auth rotation) is retryable, not latched forever.
 */
async function getClient(): Promise<Redis | null> {
  if (!REDIS_URL) return null;
  if (client) return client;
  if (clientInitFailed) return null;
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    try {
      const { default: Redis } = await import('ioredis');
      const c = new Redis(REDIS_URL, {
        lazyConnect: true,
        // Fail fast on a single command; the wrapper handles the catch.
        connectTimeout: 1_000,
        maxRetriesPerRequest: 1,
        // Don't queue commands while disconnected -- we'd rather bypass.
        enableOfflineQueue: false,
      });
      c.on('error', () => { /* swallow; per-command catch logs once */ });
      client = c;
      return c;
    } catch (err) {
      clientInitFailed = true;
      logOutage('init failed', err);
      return null;
    } finally {
      clientPromise = null;
    }
  })();
  return clientPromise;
}

function logOutage(reason: string, err?: unknown): void {
  if (degraded) return;
  degraded = true;
  // The brief: logged once, never a failed request. One line, not a stack
  // trace. Operators grep their logs for this string; the rest is noise.
  const detail = err instanceof Error ? err.message : String(err ?? '');
  console.warn(
    `[ulpin-cache] Redis bypassed (${reason}${detail ? `: ${detail}` : ''}). `
    + 'Subsequent requests will be served without the cache until Redis recovers.',
  );
}

function logRecovery(): void {
  if (!degraded) return;
  degraded = false;
  console.info('[ulpin-cache] Redis recovered; cache reads/writes resumed.');
}

/**
 * Read a JSON-encoded value. Returns undefined on miss, on parse failure,
 * and on any Redis error. Callers treat all three as "not cached".
 *
 * The bytes Redis returns are treated as untrusted even on a self-hosted
 * instance: a shared keyspace, a misconfigured migration, or a future
 * write path that didn't go through this module could address the same
 * key with arbitrary JSON. The minimal defence is to drop any value
 * whose top-level shape is not a plain object/array, and to refuse any
 * value whose own keys include the prototype-pollution vector `__*`.
 * That closes the spread-and-serialise-back-out path that would let a
 * `__proto__` field leak into a route response.
 */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const c = await getClient();
  if (!c) return undefined;
  try {
    const raw = await c.get(key);
    if (raw === null) return undefined;
    logRecovery();
    return sanitise<T>(JSON.parse(raw));
  } catch (err) {
    logOutage('get failed', err);
    return undefined;
  }
}

/**
 * Validate a value just out of JSON.parse. The check is intentionally
 * cheap: confirm it is an object or array, confirm its own keys do not
 * include any `__`-prefixed name (the spread-and-serialise vector for
 * prototype pollution). Anything else, treat as "not cached" and let
 * the loader run.
 */
function sanitise<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item !== 'object') return undefined;
    }
    return value as T;
  }
  for (const k of Object.keys(value as object)) {
    if (k.startsWith('__')) return undefined;
  }
  return value as T;
}

/**
 * Write a JSON-encoded value with a TTL. Silently no-ops on any error --
 * the cache is an optimisation, and a failed write is the same as a miss
 * for the next reader.
 */
export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const c = await getClient();
  if (!c) return;
  try {
    const payload = JSON.stringify(value);
    // ioredis accepts a number for PX; the wrapper normalises to integer ms.
    await c.set(key, payload, 'PX', Math.max(1, Math.floor(ttlMs)));
    logRecovery();
  } catch (err) {
    logOutage('set failed', err);
  }
}

/**
 * Delete one key. Currently unused -- Rule 1 says PATCH never invalidates --
 * but exposed for diagnostics and for the version-bump flush path that a
 * re-seed would want to run from a one-off script.
 */
export async function cacheDel(key: string): Promise<void> {
  const c = await getClient();
  if (!c) return;
  try {
    await c.del(key);
    logRecovery();
  } catch (err) {
    logOutage('del failed', err);
  }
}

/**
 * Flush every key under a prefix. The version-bump path uses this when
 * ULPIN_CACHE_VERSION changes: rather than threading the new version
 * through every caller, the operator can call `cacheFlushPrefix('ulpin:')`
 * to drop everything before the new version's keys start arriving.
 *
 * The prefix is matched against `PREFIX_ALLOW` before it is composed
 * into the SCAN MATCH glob. A stray `*`, `?`, or `[set]` in the prefix
 * would otherwise widen the SCAN to the entire keyspace (or a
 * targeted subset of it) and the subsequent `del(...batch)` would
 * delete keys this module never wrote. The allow-list is the strict
 * subset the keys actually use: lowercase letters, digits, `_`, `-`,
 * `.`, and `:`.
 */
export async function cacheFlushPrefix(prefix: string): Promise<number> {
  if (!PREFIX_ALLOW.test(prefix)) {
    // Refuse the operation; do not call the cache at all. The caller
    // sees 0 keys dropped, which is the same answer as "nothing to do"
    // but with a console.warn that makes the misconfiguration visible.
    console.warn(
      `[ulpin-cache] cacheFlushPrefix refused: prefix ${JSON.stringify(prefix)} `
      + 'contains characters outside [a-z0-9_.-:]. Refusing to SCAN/DEL.',
    );
    return 0;
  }
  const c = await getClient();
  if (!c) return 0;
  try {
    let cursor = '0';
    let dropped = 0;
    do {
      // SCAN, not KEYS: KEYS blocks the server on a large keyspace; SCAN
      // walks incrementally and is safe to run against a populated cache.
      // eslint-disable-next-line no-constant-condition
      const [next, batch] = await c.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (batch.length) {
        await c.del(...batch);
        dropped += batch.length;
      }
    } while (cursor !== '0');
    logRecovery();
    return dropped;
  } catch (err) {
    logOutage('flush failed', err);
    return 0;
  }
}

/**
 * For diagnostics: true when the wrapper is currently bypassing Redis.
 * The probe scripts read this; nothing in the request path does.
 *
 * The semantic is "Redis is not currently serving this process's
 * requests". That covers two cases:
 *   1. ULPIN_REDIS_URL was never set (deliberate: dev, CI, a workstation
 *      that has never had Redis). Every cache call no-ops.
 *   2. A previous call failed and the `degraded` latch tripped
 *      (incident: a real outage). Every call no-ops until the next
 *      successful call clears the latch.
 *
 * Conflating the two under one label is the right call for the
 * `x-ulpin-cache` header: in both cases the user-visible answer is
 * `bypass`, not `miss`. `miss` is reserved for "Redis is up, this
 * key was new", which is the only case where the value the caller
 * computed will be in Redis for the next reader.
 */
export function isCacheDegraded(): boolean {
  if (!REDIS_URL) return true;
  return degraded;
}

/**
 * For tests: force the wrapper back to the "fresh start" state so a
 * unit test that exercises the degraded path can be re-run.
 */
export function _resetForTests(): void {
  if (client) {
    void client.quit().catch(() => {});
  }
  client = null;
  clientInitFailed = false;
  clientPromise = null;
  degraded = false;
}
