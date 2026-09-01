/**
 * Measures the real terrain relief across the AOI.
 *
 * The database stores a flat 12.0 m ground_elev placeholder (no DEM supplied),
 * and lib/cesium/terrain.ts shifts every stack onto the sampled terrain surface
 * instead. This reports how much correction that actually applies -- i.e.
 * whether the reconciliation is load-bearing here or a no-op.
 *
 * Runs Cesium headlessly in Node; terrain sampling needs no DOM.
 */
import { readFileSync } from 'node:fs';
import {
  Ion, Cartographic, createWorldTerrainAsync, sampleTerrainMostDetailed,
} from 'cesium';

const env = readFileSync('.env.local', 'utf8');
const token = env.match(/NEXT_PUBLIC_CESIUM_TOKEN=(.+)/)?.[1]?.trim();
if (!token) throw new Error('no NEXT_PUBLIC_CESIUM_TOKEN in .env.local');
Ion.defaultAccessToken = token;

const STORED_GROUND = 12.0; // the placeholder in the DB

const fc = JSON.parse(readFileSync('data/api/buildings.json', 'utf8'));
const points = fc.features.map((f) => {
  const ring = f.geometry.coordinates[0];
  const n = Math.max(1, ring.length - 1);
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return Cartographic.fromDegrees(x / n, y / n);
});

const terrain = await createWorldTerrainAsync();
const sampled = await sampleTerrainMostDetailed(terrain, points);
const h = sampled.map((c) => c.height).filter(Number.isFinite);
h.sort((a, b) => a - b);

const pick = (q) => h[Math.floor(q * (h.length - 1))];
const mean = h.reduce((a, b) => a + b, 0) / h.length;

// Cesium World Terrain reports heights above the WGS84 ELLIPSOID, not sea
// level. Around Visakhapatnam the geoid sits roughly 60 m below the ellipsoid,
// so these read negative even though the ground is well above the sea. What
// matters for placement is the spread, not the sign.
console.log('  (heights are ellipsoidal; the geoid here is ~60 m below the ellipsoid)');
console.log(`  buildings sampled : ${h.length}`);
console.log(`  terrain min       : ${h[0].toFixed(1)} m`);
console.log(`  terrain median    : ${pick(0.5).toFixed(1)} m`);
console.log(`  terrain max       : ${h[h.length - 1].toFixed(1)} m`);
console.log(`  relief across AOI : ${(h[h.length - 1] - h[0]).toFixed(1)} m`);
console.log('');
console.log(`  stored ground_elev: ${STORED_GROUND.toFixed(1)} m (flat placeholder)`);
console.log(`  mean correction   : ${(mean - STORED_GROUND).toFixed(1)} m`);
console.log(`  largest correction: ${Math.max(
  Math.abs(h[0] - STORED_GROUND),
  Math.abs(h[h.length - 1] - STORED_GROUND),
).toFixed(1)} m`);
console.log('');
console.log(
  `  Without reconciliation, the worst-placed building would sit ` +
  `${Math.max(
    Math.abs(h[0] - STORED_GROUND),
    Math.abs(h[h.length - 1] - STORED_GROUND),
  ).toFixed(0)} m off the ground.`,
);
