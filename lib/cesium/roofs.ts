import type { UseType } from '@/lib/types';
import { ringCentroid } from '@/lib/geo';

/**
 * Roof geometry for the architectural model: FLAT with a parapet.
 *
 * Every use type in this AOI gets the same treatment -- a recessed deck with
 * an upstand parapet -- because that is what real roofs here look like. The
 * earlier pitched builders (gabled/hipped/sawtooth) were removed: on square
 * footprints the shortened hip ridge collapsed into a pyramid that read as a
 * brown cone on top of every building.
 *
 * Each builder returns roof faces as raw [lon, lat, z] vertex lists. The
 * BuildingModelLayer wraps them in a PolygonHierarchy with
 * `perPositionHeight`, which is what makes the recessed deck actually render
 * -- giving the polygon a constant `height` would flatten it to wall-top
 * height. Returning raw coordinates (rather than a baked hierarchy) also lets
 * the layer re-emit them translated by the current explode lift.
 *
 * The walls are extruded by the BuildingModelLayer itself -- these functions
 * only own the roof surface, which keeps one wall extrusion per storey.
 *
 * `ring` is a closed linear ring of [lon, lat] vertices, as held in the
 * GeoJSON footprint.
 */

export interface Roof {
  /** Roof faces, each a closed list of [lon, lat, z] vertices. */
  faces: Array<Array<[number, number, number]>>;
  /**
   * Vertical wall faces that should take the wall tone, not the roof tone.
   * Always empty now that every roof is flat, but kept in the interface so
   * the layer's shared face-emission code stays unchanged.
   */
  wallFaces: Array<Array<[number, number, number]>>;
  /** Absolute scene-Z the roof surface starts at (top of the wall). */
  baseZ: number;
}

/** Metres-per-degree at a latitude, equirectangular. */
function mPerDeg(lat: number): { x: number; y: number } {
  return {
    x: 111320 * Math.cos((lat * Math.PI) / 180),
    y: 110574,
  };
}

/**
 * Inset a ring toward its centroid by `insetM` metres, vertex-wise. Cheap and
 * good enough for parapets and caps on these small footprints.
 */
function insetRingM(ring: number[][], insetM: number): number[][] {
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  const m = mPerDeg(cLat);
  const n = Math.max(1, ring.length - 1);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const lon = ring[i][0];
    const lat = ring[i][1];
    const dx = (lon - cLon) * m.x;
    const dy = (lat - cLat) * m.y;
    const d = Math.hypot(dx, dy);
    if (d < insetM + 0.4) {
      out.push([lon, lat]);
    } else {
      out.push([cLon + (dx - (dx / d) * insetM) / m.x, cLat + (dy - (dy / d) * insetM) / m.y]);
    }
  }
  return out;
}

/**
 * Flat roof with a real parapet: the parapet is a short ring 0.5 m above the
 * deck, and the deck itself sits 0.15 m below the wall top so it reads as a
 * recessed slab with an upstand -- the signature look of a concrete roof --
 * rather than a sticker at wall-top height.
 */
function flatWithParapet(ring: number[][], baseZ: number): Roof {
  const deckZ = baseZ - 0.15;
  const parapetZ = baseZ + 0.5;
  const deck: Array<[number, number, number]> = insetRingM(ring, 0.35).map(
    ([lon, lat]) => [lon, lat, deckZ] as [number, number, number],
  );
  // Parapet: a single flat ring at parapet height covering the wall->deck
  // annulus, with the deck face below it doing the recess work.
  const parapet: Array<[number, number, number]> = [];
  const n = Math.max(1, ring.length - 1);
  for (let i = 0; i < n; i++) {
    parapet.push([ring[i][0], ring[i][1], parapetZ]);
  }
  return { baseZ, faces: [parapet, deck], wallFaces: [] };
}

/** Flat parapet roof for every use type. */
export function buildRoof(
  use: UseType,
  ring: number[][],
  groundZ: number,
  heightM: number,
): Roof {
  void use;
  return flatWithParapet(ring, groundZ + Math.max(2, heightM));
}
