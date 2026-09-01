import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import type { UseType } from '@/lib/types';
import { orientedDims, ringCentroid } from '@/lib/geo';

/**
 * Procedural roof geometry for the architectural model.
 *
 * Each builder returns one or two {@link Cesium.PolygonHierarchy} objects that
 * can be fed straight into a {@link Cesium.Entity} polygon, plus the absolute
 * base height the roof sits at. The walls are extruded by the BuildingModelLayer
 * itself -- these functions only own the roof surface, which lets us vary the
 * shape per use type while reusing one wall extrusion.
 *
 * `ring` is a closed linear ring of [lon, lat] vertices, as held in the
 * GeoJSON footprint.
 */

export interface Roof {
  /** One or two roof polygons (gabled roofs return two). */
  faces: Cesium.PolygonHierarchy[];
  /** Absolute scene-Z the roof surface starts at (top of the wall). */
  baseZ: number;
}

const DEG2RAD = Math.PI / 180;
const EARTH_R = 6378137; // Cesium's WGS84 equatorial radius is close enough.

/**
 * Walk a closed ring along the principal axis and return its two endpoints.
 * These are the basis for the gable ridge.
 */
function longAxisEndpoints(ring: number[][]): {
  a: { lon: number; lat: number };
  b: { lon: number; lat: number };
  longAxisDeg: number;
} {
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((cLat * Math.PI) / 180);
  const dims = orientedDims(ring);
  const rad = dims.longAxisDeg * DEG2RAD;
  // Walk `lengthM/2` along the principal axis from the centroid.
  const half = dims.lengthM / 2;
  const dxM = Math.cos(rad) * half;
  const dyM = Math.sin(rad) * half;
  const a = {
    lon: cLon + dxM / mPerDegLon,
    lat: cLat + dyM / mPerDegLat,
  };
  const b = {
    lon: cLon - dxM / mPerDegLon,
    lat: cLat - dyM / mPerDegLat,
  };
  return { a, b, longAxisDeg: dims.longAxisDeg };
}

/** Build a Cesium polygon hierarchy for a single (lon,lat,z) list. */
function polyHierarchy(coords: Array<[number, number, number]>): Cesium.PolygonHierarchy {
  const flat: number[] = [];
  for (const [lon, lat, z] of coords) {
    flat.push(lon, lat, z);
  }
  return new Cesium.PolygonHierarchy(
    Cesium.Cartesian3.fromDegreesArrayHeights(flat),
  );
}

/**
 * Gabled roof -- two pitched planes meeting at a ridge along the building's
 * long axis. The ridge sits `peakRise` metres above the wall top.
 */
function gabledRoof(
  ring: number[][],
  baseZ: number,
  peakRise: number,
): Roof {
  const n = Math.max(1, ring.length - 1);
  const { a, b, longAxisDeg } = longAxisEndpoints(ring);
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((ring[0][1] * Math.PI) / 180);

  // Perimeter vertices stay at baseZ; ridge endpoints lift to baseZ + peakRise.
  const ringZ: Array<[number, number, number]> = ring.slice(0, n).map(([lon, lat]) =>
    [lon, lat, baseZ] as [number, number, number],
  );
  const aZ: [number, number, number] = [a.lon, a.lat, baseZ + peakRise];
  const bZ: [number, number, number] = [b.lon, b.lat, baseZ + peakRise];

  // Each gable plane is a triangle fan: every consecutive pair of perimeter
  // vertices + the ridge endpoint on that side. The split is by signed
  // projection along the short axis.
  const rad = longAxisDeg * DEG2RAD;
  const sinT = Math.sin(rad);
  const cosT = Math.cos(rad);
  // Centre of the ring in projected metres.
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  const sideOf = (lon: number, lat: number): number => {
    const x = (lon - cLon) * mPerDegLon;
    const y = (lat - cLat) * mPerDegLat;
    // Short-axis projection = perpendicular to long axis.
    return -x * sinT + y * cosT;
  };
  const sideA: Array<[number, number, number]> = [];
  const sideB: Array<[number, number, number]> = [];
  for (const v of ringZ) {
    if (sideOf(v[0], v[1]) >= 0) sideA.push(v); else sideB.push(v);
  }
  // Fall back to a straight split if the sign test partitions nothing.
  const partA = sideA.length > 1 ? sideA : ringZ.filter((_, i) => i % 2 === 0);
  const partB = sideB.length > 1 ? sideB : ringZ.filter((_, i) => i % 2 === 1);

  const fan = (verts: Array<[number, number, number]>, apex: [number, number, number]) => {
    const out: Array<[number, number, number]> = [apex];
    for (const v of verts) out.push(v);
    out.push(apex);
    return out;
  };
  return {
    baseZ,
    faces: [polyHierarchy(fan(partA, aZ)), polyHierarchy(fan(partB, bZ))],
  };
}

/**
 * Flat roof with a parapet -- a small inset ring raised 1.5 m above the wall.
 * Reads as a commercial/institutional box.
 */
function flatWithParapet(
  ring: number[][],
  baseZ: number,
): Roof {
  const n = Math.max(1, ring.length - 1);
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((cLat * Math.PI) / 180);

  // 3 % inset, converted to degrees.
  const inset: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const lon = ring[i][0];
    const lat = ring[i][1];
    inset.push([
      cLon + (lon - cLon) * 0.97,
      cLat + (lat - cLat) * 0.97,
      baseZ + 1.5,
    ]);
  }
  return { baseZ, faces: [polyHierarchy(inset)] };
}

/**
 * Hipped roof -- a centre apex with four triangular faces. Robust to rings
 * that are not strictly rectangles: the apex is the centroid lifted by
 * `peakRise`.
 */
function hippedRoof(
  ring: number[][],
  baseZ: number,
  peakRise: number,
): Roof {
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  const apex: [number, number, number] = [cLon, cLat, baseZ + peakRise];
  const n = Math.max(1, ring.length - 1);
  const ringZ: Array<[number, number, number]> = ring.slice(0, n).map(([lon, lat]) =>
    [lon, lat, baseZ] as [number, number, number],
  );
  // Triangulate as a fan from the apex.
  const fan: Array<[number, number, number]> = [apex];
  for (const v of ringZ) fan.push(v);
  fan.push(apex);
  return { baseZ, faces: [polyHierarchy(fan)] };
}

/**
 * Sawtooth roof -- N small ridges along the long axis. Every other "tooth"
 * has its far edge raised by `peakRise`, which gives the characteristic
 * industrial lighting profile. N is a function of the long-axis length.
 */
function sawtoothRoof(
  ring: number[][],
  baseZ: number,
  peakRise: number,
): Roof {
  const { a, b, longAxisDeg } = longAxisEndpoints(ring);
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((ring[0][1] * Math.PI) / 180);
  const rad = longAxisDeg * DEG2RAD;
  const sinT = Math.sin(rad);
  const cosT = Math.cos(rad);
  // Project the ring's vertices onto the long axis (u) and short axis (v).
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  type Proj = { u: number; v: number; lon: number; lat: number };
  const projected: Proj[] = [];
  const n = Math.max(1, ring.length - 1);
  for (let i = 0; i < n; i++) {
    const lon = ring[i][0];
    const lat = ring[i][1];
    const x = (lon - cLon) * mPerDegLon;
    const y = (lat - cLat) * mPerDegLat;
    projected.push({
      lon, lat,
      u: x * cosT + y * sinT,
      v: -x * sinT + y * cosT,
    });
  }
  const uMin = Math.min(...projected.map((p) => p.u));
  const uMax = Math.max(...projected.map((p) => p.u));
  const vMin = Math.min(...projected.map((p) => p.v));
  const vMax = Math.max(...projected.map((p) => p.v));
  const lengthM = uMax - uMin;

  // 1 tooth per 4 m, clamped to [3, 14].
  const teeth = Math.max(3, Math.min(14, Math.round(lengthM / 4)));

  const fromUv = (u: number, v: number, z: number): [number, number, number] => {
    const x = u * cosT - v * sinT;
    const y = u * sinT + v * cosT;
    return [
      cLon + x / mPerDegLon,
      cLat + y / mPerDegLat,
      z,
    ];
  };

  const faces: Cesium.PolygonHierarchy[] = [];
  for (let i = 0; i < teeth; i++) {
    const u0 = uMin + (lengthM * i) / teeth;
    const u1 = uMin + (lengthM * (i + 1)) / teeth;
    const raised = i % 2 === 0;
    const zNear = baseZ;
    const zFar = baseZ + (raised ? peakRise : 0);
    const quad: Array<[number, number, number]> = [
      fromUv(u0, vMin, zNear),
      fromUv(u1, vMin, zNear),
      fromUv(u1, vMax, zFar),
      fromUv(u0, vMax, zFar),
    ];
    faces.push(polyHierarchy(quad));
  }
  return { baseZ, faces };
}

/** Pick a roof builder for the given use type. */
export function buildRoof(
  use: UseType,
  ring: number[][],
  groundZ: number,
  heightM: number,
): Roof {
  const baseZ = groundZ + Math.max(2, heightM);
  // Peak rise scales gently with height so a one-storey house and a ten-storey
  // tower don't end up with the same roof pitch.
  const peakRise = Math.max(1.2, Math.min(4.5, heightM * 0.35));
  switch (use) {
    case 'residential':
      return gabledRoof(ring, baseZ, peakRise);
    case 'commercial':
      return flatWithParapet(ring, baseZ);
    case 'institutional':
      return hippedRoof(ring, baseZ, peakRise);
    case 'industrial':
      return sawtoothRoof(ring, baseZ, peakRise);
  }
}

/**
 * The footprint ring as a closed [lon,lat,lon,lat,...] at a single height,
 * suitable for `PolygonHierarchy` + `extrudedHeight` to make a wall extrusion.
 */
export function wallPositions(ring: number[][], baseZ: number, topZ: number): {
  positions: number[];
} {
  const n = Math.max(1, ring.length - 1);
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    positions.push(ring[i][0], ring[i][1], topZ);
  }
  // We hand the positions back as a flat [lon,lat,z,...] so the caller can use
  // them with PolygonHierarchy.fromCartesianArray if they prefer, but Cesium's
  // PolygonHierarchy constructor wants a Cartesian3[]; this helper is for
  // debug/diagnostics. The real wall extrusion is built with flatLonLat in the
  // BuildingModelLayer.
  return { positions: [baseZ, topZ, ...positions] };
}

// Suppress an unused-import warning when the dev tree is restructured.
void EARTH_R;
