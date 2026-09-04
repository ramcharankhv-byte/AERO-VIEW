// scripts/_ioredis_shim.mjs
//
// Node ESM loader hook: redirects every import of 'ioredis' to this
// module's default export, which is a Map-backed stand-in that
// implements the four methods lib/cache/redis.ts uses (get, set, del,
// scan, quit) and a no-op `on` for the wrapper's event handlers.
//
// The shim does not claim to be wire-compatible with ioredis; it
// implements only what the cache wrapper actually calls, and asserts
// on anything else. The wrapper is small enough that this list is
// stable.

import { performance } from 'node:perf_hooks';

if (process.env.SHIM_DEBUG) {
  console.error('[shim] loaded, SHIM_DEBUG=' + process.env.SHIM_DEBUG);
}

/** An in-process implementation of the ioredis surface the cache uses. */
class MapRedis {
  constructor() {
    /** @type {Map<string, { value: string, expiresAt: number|null }>} */
    this.store = new Map();
    this.degraded = false;
  }

  // ----- key/value -----
  async get(key) {
    const entry = this.store.get(key);
    if (process.env.SHIM_DEBUG === '1') console.error(`[shim.get] key=${key} ${entry ? 'HIT' : 'MISS'} store.size=${this.store.size}`);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < performance.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(key, value, mode, ms) {
    if (process.env.SHIM_DEBUG === '1') console.error(`[shim.set] key=${key} mode=${mode} ms=${ms} value.len=${typeof value === 'string' ? value.length : '?'}`);
    if (mode === 'PX') {
      this.store.set(key, { value, expiresAt: performance.now() + ms });
    } else {
      this.store.set(key, { value, expiresAt: null });
    }
    return 'OK';
  }
  async del(...keys) {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }
  // ----- scan -----
  async scan(cursor, _match, pattern, _count, _n) {
    // pattern is something like 'ulpin:*'. We do an exact-prefix
    // match; the only caller in the project uses a real prefix.
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const matched = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) matched.push(k);
    }
    return ['0', matched];
  }
  async quit() { this.store.clear(); return 'OK'; }
  on() { /* swallow; the wrapper does nothing with the event handler */ }
  off() { /* noop */ }
}

const shared = new MapRedis();

/** Default export: every `import 'ioredis'` gets the same instance. */
const Redis = function Redis() { return shared; };
// ioredis also has a static `Redis.Command` etc; the wrapper does not
// use any, so we don't define them.
export default Redis;
