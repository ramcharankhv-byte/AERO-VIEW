// Copies the prebuilt CesiumJS assets into public/cesium so the runtime can
// resolve workers, Assets/ and Widgets/ from CESIUM_BASE_URL.
import { cp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'node_modules', 'cesium', 'Build', 'Cesium');
const DEST = join(process.cwd(), 'public', 'cesium');

try {
  await access(SRC);
} catch {
  console.warn('[copy-cesium] cesium build assets not found, skipping');
  process.exit(0);
}

await rm(DEST, { recursive: true, force: true });
await cp(SRC, DEST, { recursive: true });
console.log('[copy-cesium] copied Cesium build assets -> public/cesium');
