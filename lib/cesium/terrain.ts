import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';

/**
 * Ground-height reconciliation.
 *
 * The database stores ground_elev from a DEM when one is supplied and 12.0 m
 * otherwise (see scripts/02_heights.py). Siripuram is hilly, so placing a
 * stack at a flat 12 m against real World Terrain would leave buildings
 * floating over the low ground and buried in the slopes.
 *
 * So we sample the actual terrain under each building once at load and shift
 * each stack vertically by the difference. The schema stays exactly as
 * specified; only the rendering is reconciled. With ellipsoid terrain (no ion
 * token) the sampled height is 0 and the shift simply removes the nominal 12 m,
 * which is also correct.
 */

export type GroundMap = Map<number, number>;

export interface SamplePoint {
  id: number;
  lon: number;
  lat: number;
}

/**
 * Sample terrain height under each point. Returns an empty map on failure --
 * callers then fall back to the stored ground_elev, which is never worse than
 * what we started with.
 */
export async function sampleGroundHeights(
  terrainProvider: Cesium.TerrainProvider,
  points: SamplePoint[],
): Promise<GroundMap> {
  const out: GroundMap = new Map();
  if (points.length === 0) return out;

  // An ellipsoid provider has no tiles to sample; everything is 0 by definition.
  if (terrainProvider instanceof Cesium.EllipsoidTerrainProvider) {
    for (const p of points) out.set(p.id, 0);
    return out;
  }

  try {
    const cartos = points.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
    const sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, cartos);
    sampled.forEach((c, i) => {
      const h = c.height;
      out.set(points[i].id, Number.isFinite(h) ? h : 0);
    });
  } catch {
    // Terrain sampling is best-effort; leave the map empty.
    return new Map();
  }
  return out;
}

/**
 * Convert a stored absolute Z into the height the scene should draw it at.
 *
 * @param storedZ      z from the database (metres, relative to ground_elev)
 * @param groundElev   the building's stored ground_elev
 * @param terrainH     sampled terrain height, or undefined if unavailable
 */
export function toSceneZ(
  storedZ: number,
  groundElev: number,
  terrainH: number | undefined,
): number {
  if (terrainH === undefined) return storedZ;
  return terrainH + (storedZ - groundElev);
}
