// scripts/_ioredis_loader.mjs
//
// ESM loader hook: does two things.
//
// 1. Redirects any import of 'ioredis' to the in-process Map-backed
//    shim, so the cache wrapper can be exercised without a real
//    Redis. Used by scripts/measure_cache.mjs and the cache tests.
//
// 2. Resolves extension-less relative imports to .ts. The project is
//    TypeScript-first; source files import each other without an
//    extension. Node's ESM loader requires an extension, so without
//    this hook the simplest test import of any of the cache modules
//    explodes on the first `from '../db'` it walks through.
//
// Register with:
//   node --import ./scripts/_register_shim.mjs ...

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shimUrl = pathToFileURL(path.join(here, '_ioredis_shim.mjs')).href;

/** Extensions Node's ESM loader will accept when it sees a relative
 *  path. TypeScript first, then the others, so the project's own
 *  files win on a tie. */
const RESOLUTION_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ioredis') {
    return { url: shimUrl, shortCircuit: true, format: 'module' };
  }

  // Extension-less relative paths: try each candidate, return the
  // first that exists. Only relative (./... or ../...) -- absolute
  // bare specifiers are left to the standard resolver so things
  // like 'node:fs' and 'next/server' still work.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const hasExt = path.extname(specifier);
    if (!hasExt) {
      // context.parentURL is the URL of the importing module. We
      // resolve the relative path against the directory of that URL.
      const parentURL = context.parentURL;
      if (parentURL) {
        const parentPath = fileURLToPath(parentURL);
        const candidate = path.resolve(path.dirname(parentPath), specifier);
        for (const ext of RESOLUTION_EXTENSIONS) {
          const withExt = candidate + ext;
          if (existsSync(withExt)) {
            // Do NOT set `format` -- Node 22 picks the right parser
            // (TypeScript strip-types, ESM, CJS) from the extension
            // itself. Overriding it to 'module' here is what
            // crashed the cache tests with "Unexpected token '{'":
            // it told the loader to skip the TS transform and feed
            // raw TS straight to the ESM parser.
            return {
              url: pathToFileURL(withExt).href,
              shortCircuit: true,
            };
          }
        }
        // Also try as a directory with index.<ext>
        for (const ext of RESOLUTION_EXTENSIONS) {
          const withIndex = path.join(candidate, `index${ext}`);
          if (existsSync(withIndex)) {
            return {
              url: pathToFileURL(withIndex).href,
              shortCircuit: true,
            };
          }
        }
      }
    }
  }

  return nextResolve(specifier, context);
}
