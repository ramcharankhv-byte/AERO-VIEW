import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { ringCentroid } from '@/lib/geo';
import { MATERIALS } from './materials';
import type { UseType } from '@/lib/types';

/**
 * Rooftop fixtures appropriate to each use type.
 *
 * Pure factories: they take a (lon, lat, baseZ) plus a footprint radius so
 * fixtures sit safely inside the roof, and return Entity instances that the
 * BuildingModelLayer adds to its CustomDataSource. The factories do NOT
 * register the entities anywhere -- that is the layer's job.
 *
 * Entities are tagged with `kind: 'fixture'` so the picker can ignore them
 * (picking on a water tank should not switch the active building).
 */

interface MakeOpts {
  lon: number;
  lat: number;
  baseZ: number;
  /** Half-extent in metres, used to keep fixtures inside the roof. */
  radiusM: number;
}

const tagFixture = (e: Cesium.Entity) => {
  (e as Cesium.Entity & { __tag?: { kind: string; id: number } }).__tag = {
    kind: 'fixture',
    id: 0,
  };
};

const fixtureMaterial = new Cesium.ColorMaterialProperty(MATERIALS.buildingModelFixture);
/** Slightly lighter tone for secondary fixtures so rows don't read as one blob. */
const fixtureMaterialLight = new Cesium.ColorMaterialProperty(
  MATERIALS.buildingModelFixture.withAlpha(0.8),
);

function box(
  lon: number, lat: number,
  baseZ: number, topZ: number,
  halfW: number, halfD: number,
  material: Cesium.MaterialProperty = fixtureMaterial,
): Cesium.Entity {
  // Cesium's box takes centre + full dimensions, so width = 2*halfW.
  return new Cesium.Entity({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, (baseZ + topZ) / 2),
    box: {
      dimensions: new Cesium.Cartesian3(halfW * 2, halfD * 2, topZ - baseZ),
      material,
      outline: false,
    },
  });
}

function cylinder(
  lon: number, lat: number,
  baseZ: number, topZ: number,
  radius: number,
  topRadius = radius,
): Cesium.Entity {
  return new Cesium.Entity({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, (baseZ + topZ) / 2),
    cylinder: {
      length: topZ - baseZ,
      topRadius,
      bottomRadius: radius,
      material: fixtureMaterial,
      outline: false,
    },
  });
}

function residentialFixtures({ lon, lat, baseZ, radiusM }: MakeOpts): Cesium.Entity[] {
  // Black tank on a stand (the standard Indian rooftop setup), a stairhead,
  // and a small laundry/drying line offset into a corner.
  const stand = cylinder(lon + 0.000012, lat - 0.000009, baseZ, baseZ + 0.5, 0.55, 0.45);
  const tank = cylinder(lon + 0.000012, lat - 0.000009, baseZ + 0.5, baseZ + 1.7, 0.75);
  const stair = box(lon - 0.000014, lat + 0.000010, baseZ, baseZ + 2.2, 0.8, 0.7);
  const line = box(lon + 0.000020, lat + 0.000018, baseZ, baseZ + 0.06, 1.2, 0.04,
    fixtureMaterialLight);
  [stand, tank, stair, line].forEach(tagFixture);
  void radiusM;
  return [stand, tank, stair, line];
}

function commercialFixtures({ lon, lat, baseZ, radiusM }: MakeOpts): Cesium.Entity[] {
  // Two rows of 3 AC condensers on plinths, a lift overrun at one end, and a
  // rooftop signboard slab along one edge.
  const rowZ = baseZ + 0.35;
  const acs: Cesium.Entity[] = [];
  const rowLenM = Math.min(5, radiusM * 1.2);
  for (let i = 0; i < 3; i++) {
    const dx = ((i - 1) / 1) * (rowLenM / 2) * 0.00001; // tiny step in lon
    acs.push(box(lon + dx, lat + 0.000015, rowZ, rowZ + 0.85, 0.42, 0.32,
      fixtureMaterialLight));
  }
  for (let i = 0; i < 3; i++) {
    const dx = ((i - 1) / 1) * (rowLenM / 2) * 0.00001;
    acs.push(box(lon + dx, lat - 0.000013, rowZ, rowZ + 0.85, 0.42, 0.32,
      fixtureMaterialLight));
  }
  const overrun = box(lon - 0.000018, lat - 0.000002,
    baseZ, baseZ + 1.6, 1.0, 1.0);
  const sign = box(lon + 0.000004, lat - Math.min(0.000028, radiusM * 0.000016),
    baseZ, baseZ + 1.2, Math.min(1.6, radiusM * 0.5), 0.08,
    fixtureMaterialLight);
  [...acs, overrun, sign].forEach(tagFixture);
  void radiusM;
  return [...acs, overrun, sign];
}

function institutionalFixtures({ lon, lat, baseZ, radiusM }: MakeOpts): Cesium.Entity[] {
  // Flagpole on a stepped base, plus two rooftop canteen vents.
  const base = box(lon, lat, baseZ, baseZ + 0.3, 0.45, 0.45);
  const base2 = box(lon, lat, baseZ + 0.3, baseZ + 0.55, 0.32, 0.32);
  const pole = cylinder(lon, lat, baseZ + 0.55, baseZ + 4.8, 0.055);
  const v1 = cylinder(lon + 0.000016, lat + 0.000012, baseZ, baseZ + 0.8, 0.3);
  const v2 = cylinder(lon - 0.000014, lat + 0.000014, baseZ, baseZ + 0.8, 0.3);
  [base, base2, pole, v1, v2].forEach(tagFixture);
  void radiusM;
  return [base, base2, pole, v1, v2];
}

function industrialFixtures({ lon, lat, baseZ, radiusM }: MakeOpts): Cesium.Entity[] {
  // 6 ventilation cowls in a 2x3 grid on the flat parts of the sawtooth
  // roof, plus one skylight strip per sawtooth is implied by the roof glass
  // colour, so fixtures stay mechanical.
  const cowls: Cesium.Entity[] = [];
  const step = Math.min(0.00002, radiusM * 0.00002);
  for (const dx of [-step, 0, step]) {
    for (const dy of [-step, step]) {
      cowls.push(cylinder(lon + dx, lat + dy, baseZ, baseZ + 0.75, 0.4));
    }
  }
  // Rooftop access hut.
  const hut = box(lon - 0.000022, lat - 0.000018, baseZ, baseZ + 1.1, 0.7, 0.6,
    fixtureMaterialLight);
  [...cowls, hut].forEach(tagFixture);
  return [...cowls, hut];
}

/** Pick the equipment factory for the given use type. */
export function fixturesFor(
  use: UseType,
  ring: number[][],
  groundZ: number,
  heightM: number,
): Cesium.Entity[] {
  const { lon, lat } = ringCentroid(ring);
  // The deck sits 0.15 m below the wall top (flatWithParapet), so fixtures
  // rest on the deck rather than floating at parapet height.
  const baseZ = groundZ + Math.max(2, heightM) - 0.15;
  // A safe in-radius in metres: 70% of the greatest centroid->vertex distance.
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  let r = 1;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = (ring[i][0] - lon) * mPerDegLon;
    const dy = (ring[i][1] - lat) * mPerDegLat;
    r = Math.max(r, Math.hypot(dx, dy));
  }
  const opts: MakeOpts = { lon, lat, baseZ, radiusM: r * 0.7 };

  switch (use) {
    case 'residential':   return residentialFixtures(opts);
    case 'commercial':    return commercialFixtures(opts);
    case 'institutional': return institutionalFixtures(opts);
    case 'industrial':    return industrialFixtures(opts);
  }
}
