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

function box(
  lon: number, lat: number,
  baseZ: number, topZ: number,
  halfW: number, halfD: number,
): Cesium.Entity {
  // Cesium's box takes centre + full dimensions, so width = 2*halfW.
  return new Cesium.Entity({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, (baseZ + topZ) / 2),
    box: {
      dimensions: new Cesium.Cartesian3(halfW * 2, halfD * 2, topZ - baseZ),
      material: fixtureMaterial,
      outline: false,
    },
  });
}

function cylinder(
  lon: number, lat: number,
  baseZ: number, topZ: number,
  radius: number,
): Cesium.Entity {
  return new Cesium.Entity({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, (baseZ + topZ) / 2),
    cylinder: {
      length: topZ - baseZ,
      topRadius: radius,
      bottomRadius: radius,
      material: fixtureMaterial,
      outline: false,
    },
  });
}

function residentialFixtures({ lon, lat, baseZ, radiusM }: MakeOpts): Cesium.Entity[] {
  // Water tank + stairhead, placed slightly off-centre so the roof is not
  // perfectly symmetrical.
  const tank = cylinder(lon + 0.000012, lat - 0.000009, baseZ, baseZ + 1.5, 0.7);
  const stair = box(lon - 0.000014, lat + 0.000010, baseZ, baseZ + 2.0,
    0.75, 0.75);
  [tank, stair].forEach(tagFixture);
  void radiusM;
  return [tank, stair];
}

function commercialFixtures({ lon, lat, baseZ, radiusM }: MakeOpts): Cesium.Entity[] {
  // Row of 4 AC units along the short axis, plus a lift overrun at one end.
  const rowZ = baseZ + 0.4;
  const acs: Cesium.Entity[] = [];
  const rowLenM = Math.min(4, radiusM * 1.2);
  for (let i = 0; i < 4; i++) {
    const dx = ((i - 1.5) / 1.5) * (rowLenM / 2) * 0.00001; // tiny step in lon
    acs.push(box(lon + dx, lat + 0.000015, rowZ, rowZ + 0.8, 0.4, 0.3));
  }
  const overrun = box(lon - 0.000018, lat - 0.000015,
    baseZ, baseZ + 1.5, 1.0, 1.0);
  [...acs, overrun].forEach(tagFixture);
  void radiusM;
  return [...acs, overrun];
}

function institutionalFixtures({ lon, lat, baseZ, radiusM }: MakeOpts): Cesium.Entity[] {
  // A slim flagpole rising from a small base block.
  const base = box(lon, lat, baseZ, baseZ + 0.3, 0.4, 0.4);
  const pole = cylinder(lon, lat, baseZ + 0.3, baseZ + 4.3, 0.06);
  [base, pole].forEach(tagFixture);
  void radiusM;
  return [base, pole];
}

function industrialFixtures({ lon, lat, baseZ, radiusM }: MakeOpts): Cesium.Entity[] {
  // 4 ventilation cowls in a 2x2 grid, sitting on the flat parts of the
  // sawtooth roof.
  const cowls: Cesium.Entity[] = [];
  const step = Math.min(0.00002, radiusM * 0.00002);
  for (const [dx, dy] of [[-step, -step], [step, -step], [-step, step], [step, step]] as const) {
    cowls.push(cylinder(lon + dx, lat + dy, baseZ, baseZ + 0.7, 0.4));
  }
  cowls.forEach(tagFixture);
  return cowls;
}

/** Pick the equipment factory for the given use type. */
export function fixturesFor(
  use: UseType,
  ring: number[][],
  groundZ: number,
  heightM: number,
): Cesium.Entity[] {
  const { lon, lat } = ringCentroid(ring);
  // The roof base sits above the wall top, so the fixtures live there.
  const baseZ = groundZ + Math.max(2, heightM);
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
