import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import type { BuildingProps, GeoFC } from '@/lib/types';

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

/**
 * Tile level used to sample ground heights. See the note in
 * sampleGroundHeights() for why this is bounded rather than "most detailed".
 */
const GROUND_SAMPLE_LEVEL = 13;

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

  const cartos = points.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));

  try {
    // A BOUNDED level, not "most detailed".
    //
    // sampleTerrainMostDetailed() walks the tile pyramid to the deepest tile
    // available under every point. Over an AOI with 2,597 footprints that
    // fanned out into dozens of tile requests and ~0.8 s of boot, several of
    // them duplicated (docs/perf/before.json lists the same .terrain URL
    // fetched four times) -- all to place a datum shift.
    //
    // What this value is FOR sets how precise it needs to be: it reconciles a
    // stored nominal ground elevation against the surface actually being
    // drawn, and the result is a vertical offset for a whole building. Level 13
    // of Cesium World Terrain is roughly a 10 m posting, which over a footprint
    // is finer than the footprint itself; going deeper buys sub-metre accuracy
    // on a quantity whose input (`ground_elev`) is a DEM sample or a flat 12 m
    // placeholder to begin with.
    //
    // At this level the whole AOI is a handful of tiles, so the sampling cost
    // stops scaling with the number of buildings altogether.
    const sampled = await Cesium.sampleTerrain(terrainProvider, GROUND_SAMPLE_LEVEL, cartos);
    sampled.forEach((c, i) => {
      const h = c.height;
      out.set(points[i].id, Number.isFinite(h) ? h : 0);
    });
    return out;
  } catch {
    // The requested level may not exist for this provider or this region.
    // Falling back to the exhaustive walk is slower but always answers, and a
    // wrong datum is far more visible than a slow one.
  }

  try {
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

/**
 * Vertical shift that aligns utilities stored against the (possibly placeholder)
 * DB datum with the real terrain surface sampled at boot. Same formula in
 * UtilitiesLayer and ConflictLayer — kept here so the two cannot drift.
 */
export function datumShift(
  buildings: GeoFC<BuildingProps> | null,
  ground: GroundMap,
): number {
  if (!buildings || buildings.features.length === 0) return 0;
  let storedSum = 0;
  for (const f of buildings.features) storedSum += f.properties.ground_elev;
  const storedDatum = storedSum / buildings.features.length;

  const heights = [...ground.values()];
  if (heights.length === 0) return 0;
  const terrainMean = heights.reduce((a, b) => a + b, 0) / heights.length;
  return terrainMean - storedDatum;
}
