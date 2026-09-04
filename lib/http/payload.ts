import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';

/**
 * Compressed, cacheable JSON responses for the cadastre endpoints.
 *
 * WHY THIS EXISTS. `NextResponse.json()` streams the body with
 * `Transfer-Encoding: chunked` and no `Content-Encoding`, so the five boot
 * endpoints were shipping 4.4 MB of uncompressed GeoJSON on every cold load --
 * measured, not assumed: see docs/perf/before.json, where `app-api` is 4,408 KB
 * across five requests and the fetch phase of boot takes 2.9 seconds.
 *
 * GeoJSON is the most compressible payload a map serves: it is almost entirely
 * ASCII digits, commas and repeated property names. Brotli at quality 5 takes
 * it to roughly a tenth of its size for a few tens of milliseconds of CPU --
 * and that cost is paid ONCE, because the compressed bytes are memoised here
 * under the same revision key the data layer already uses to memoise the data.
 *
 * THREE THINGS HAPPEN HERE, and they are deliberately together:
 *
 *   1. Negotiation. Brotli when the client offers it, gzip otherwise, identity
 *      if neither -- so a curl with no Accept-Encoding still works.
 *   2. Memoisation. Compressing 2 MB of GeoJSON per request would trade
 *      network time for server time. The cache is keyed on (resource, encoding,
 *      revision), so an edit invalidates it by changing the revision.
 *   3. Validation. A strong ETag and `Cache-Control` let the browser skip the
 *      body entirely on a warm load. This is the layer that makes a second
 *      visit cheap; the client-side caches in Phase 5 make a second *lookup*
 *      cheap, which is a different problem.
 *
 * THE CACHE IS BOUNDED, AND IT HAS TO BE. The collection endpoints are a fixed
 * handful of keys, but the progressive building routes are keyed per id and per
 * page -- `building-units:412:3:0:200` -- so an unbounded Map here would grow
 * with traffic until the process died. It is an LRU with both an entry cap and
 * a BYTE budget, because the two failure modes are different: thousands of tiny
 * unit pages exhaust the entry count, while a handful of multi-megabyte
 * collections exhaust memory long before the entry count notices.
 *
 * Note what this cache holds: COMPRESSED BYTES, not documents. The documents
 * themselves are cached once, upstream, by lib/db.ts and lib/server-cache.ts.
 */

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Compression level: the knee of the ratio/time curve for large GeoJSON. */
const BROTLI_QUALITY = 5;
const GZIP_LEVEL = 6;

type Encoding = 'br' | 'gzip' | 'identity';

interface Entry {
  body: Buffer;
  encoding: Encoding;
  etag: string;
  rev: string;
}

/**
 * Caps for the compressed-body cache.
 *
 * The byte budget is the one that matters: it is sized to hold every collection
 * in every encoding it is likely to be asked for, plus a working set of
 * per-building pages, and nothing more.
 */
const MAX_ENTRIES = 256;
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * `${resource}:${encoding}` -> compressed bytes.
 *
 * A Map iterates in insertion order, so re-inserting on every read makes the
 * first key the least recently used. That is the entire eviction policy.
 */
const cache = new Map<string, Entry>();
let cachedBytes = 0;

function evictIfNeeded(): void {
  while (cache.size > MAX_ENTRIES || cachedBytes > MAX_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const entry = cache.get(oldest.value);
    if (entry) cachedBytes -= entry.body.length;
    cache.delete(oldest.value);
  }
}

function put(key: string, entry: Entry): void {
  const existing = cache.get(key);
  if (existing) {
    cachedBytes -= existing.body.length;
    cache.delete(key);
  }
  cache.set(key, entry);
  cachedBytes += entry.body.length;
  evictIfNeeded();
}

function take(key: string, rev: string): Entry | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.rev !== rev) {
    // A stale revision is dropped rather than served. Every encoding of a
    // resource shares a revision, so the siblings are stale too -- but they
    // will be dropped by this same check the moment they are asked for, which
    // is cheaper than scanning the map for them now.
    cachedBytes -= hit.body.length;
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

/** Pick the best encoding the client actually offered. */
function negotiate(req: Request): Encoding {
  const accept = req.headers.get('accept-encoding')?.toLowerCase() ?? '';
  if (accept.includes('br')) return 'br';
  if (accept.includes('gzip')) return 'gzip';
  return 'identity';
}

async function compress(raw: Buffer, encoding: Encoding): Promise<Buffer> {
  if (encoding === 'br') {
    return brotliAsync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        // Telling brotli the exact input size lets it pick its window without
        // guessing; on multi-megabyte GeoJSON that is a measurable saving.
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
  }
  if (encoding === 'gzip') return gzipAsync(raw, { level: GZIP_LEVEL });
  return raw;
}

/**
 * A weak-ish but stable ETag: length plus a cheap rolling hash of the bytes.
 *
 * Not a cryptographic digest, deliberately -- this validates a cache entry, it
 * does not authenticate anything, and hashing 2 MB with SHA-256 on every cache
 * miss is real latency for no benefit. Collisions would need two payloads of
 * identical length whose hashes agree, which the revision key already guards.
 */
function etagFor(raw: Buffer, encoding: Encoding): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 97) {
    h ^= raw[i];
    h = Math.imul(h, 0x01000193);
  }
  return `"${raw.length.toString(36)}-${(h >>> 0).toString(36)}-${encoding}"`;
}

export interface JsonPayloadOptions {
  /** Stable name for the resource, used as the memo key. */
  resource: string;
  /**
   * Revision token. When this changes the memo is dropped. Pass the data
   * layer's edit revision so a save invalidates the compressed copy too.
   */
  rev: string;
  /** Extra response headers (the x-ulpin-* provenance headers). */
  headers?: Record<string, string>;
  /**
   * `Cache-Control` for the browser. Defaults to a short private max-age with
   * a long `stale-while-revalidate`: the cadastre changes rarely, but when it
   * does the user must not be looking at yesterday's parcels for an hour.
   */
  cacheControl?: string;
}

const DEFAULT_CACHE_CONTROL = 'private, max-age=60, stale-while-revalidate=600';

/**
 * Serialise, compress, memoise and return a JSON body, honouring
 * `If-None-Match` with a 304 when the client already has it.
 */
export async function jsonPayload(
  req: Request,
  data: unknown,
  opts: JsonPayloadOptions,
): Promise<NextResponse> {
  const encoding = negotiate(req);
  const key = `${opts.resource}:${encoding}`;

  let entry = take(key, opts.rev);
  if (!entry) {
    const raw = Buffer.from(JSON.stringify(data), 'utf-8');
    const body = await compress(raw, encoding);
    entry = { body, encoding, etag: etagFor(raw, encoding), rev: opts.rev };
    put(key, entry);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': opts.cacheControl ?? DEFAULT_CACHE_CONTROL,
    etag: entry.etag,
    // Two clients on the same URL can hold different encodings; without this a
    // shared cache could hand brotli bytes to a client that never asked.
    vary: 'Accept-Encoding',
    ...opts.headers,
  };
  if (entry.encoding !== 'identity') headers['content-encoding'] = entry.encoding;

  if (req.headers.get('if-none-match') === entry.etag) {
    return new NextResponse(null, { status: 304, headers }) as NextResponse;
  }

  // Content-Length is set explicitly so the response is not chunked: the
  // browser can then show real progress and, more importantly, Next does not
  // re-encode a body we have already encoded.
  headers['content-length'] = String(entry.body.length);
  return new NextResponse(entry.body as unknown as BodyInit, {
    status: 200,
    headers,
  }) as NextResponse;
}

/** Drop every memoised payload. */
export function invalidatePayloads(): void {
  cache.clear();
  cachedBytes = 0;
}

/** Cache occupancy, for diagnostics. */
export function payloadCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cachedBytes };
}
