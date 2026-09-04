// scripts/_register_shim.mjs
//
// Tiny one-liner so the measurement script (and any other script that
// needs the in-process Redis shim) can do:
//
//   node --import ./scripts/_register_shim.mjs scripts/measure_cache.mjs
//
// instead of having to know the path to the loader file. Keeps the
// long arg out of the command line and the file path out of the script.

import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const loaderAbs = path.join(here, '_ioredis_loader.mjs');
// Register takes (path, parentURL). On Windows, the path must be a
// file:// URL; passing a raw absolute path produces a "protocol 'c:'"
// error. pathToFileURL normalises backslashes and adds the scheme.
register(pathToFileURL(loaderAbs).href, pathToFileURL(here + path.sep).href);
