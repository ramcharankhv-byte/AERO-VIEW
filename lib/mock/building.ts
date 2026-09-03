import { intBetween, pick, rngFor, weighted } from './prng';
import { PREFIX, PUBLIC_OWNER, SURNAME, subtypesFor, suffixesFor } from './names';
import type {
  BuildingMock, BuildingProps, BuildingStatus, EnrichedBuilding, GeoFC, Ring,
} from '@/lib/types';

/**
 * The synthetic building register.
 *
 * WHAT THIS MAY AND MAY NOT DO
 * ----------------------------
 * May invent: building_type, owner_org, status, the occupancy rate, and a name
 * or address for a building OSM never named.
 *
 * Must derive, never invent: built_up_m2 (summed from the real unit areas
 * wherever the detail document has them), occupancy totals (the real unit
 * count), lat/lon (the real footprint centroid), and building_type (chosen
 * only from the subtypes the real use_type and floor count permit).
 *
 * Must never touch: footprint, height_m, floors, basements, ground_elev,
 * ulpin, parcel_id, osm_id, use_type, height_source -- and, critically, a
 * `name` or `address` that came from an OSM tag. 59 of the 384 buildings in
 * this AOI carry a name a contributor actually mapped ("AU Library", "Natraj
 * Towers", "Hotel Vivana") and 6 carry a real address. Replacing mapped fact
 * with a plausible invention is the exact failure this application exists to
 * prevent, so those are passed through untouched and marked name_source /
 * address_source = 'osm_tag'.
 */

const PIN = '530003'; // Siripuram's real PIN code.

const STATUS_BY_USE: Record<string, readonly (readonly [BuildingStatus, number])[]> = {
  residential: [
    ['Occupied', 74], ['Partially occupied', 14], ['Under renovation', 6],
    ['Vacant', 4], ['Under construction', 2],
  ],
  commercial: [
    ['Occupied', 62], ['Partially occupied', 20], ['Vacant', 10],
    ['Under renovation', 5], ['Under construction', 3],
  ],
  institutional: [
    ['Occupied', 84], ['Partially occupied', 8], ['Under renovation', 6],
    ['Vacant', 2],
  ],
  industrial: [
    ['Occupied', 66], ['Partially occupied', 12], ['Vacant', 14],
    ['Under renovation', 8],
  ],
};

/** Occupancy rate bands, by use type. */
const OCCUPANCY_BAND: Record<string, readonly [number, number]> = {
  residential: [0.62, 0.98],
  commercial: [0.55, 0.95],
  institutional: [0.7, 1.0],
  industrial: [0.5, 0.92],
};

/** Centroid of a polygon's outer ring. */
function ringCentroid(ring: number[][]): { lon: number; lat: number } {
  const n = Math.max(1, ring.length - 1);
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return { lon: x / n, lat: y / n };
}

/** Planar area of a ring in m2, adequate at AOI scale. */
function ringAreaM2(ring: number[][]): number {
  if (ring.length < 4) return 0;
  const latRad = (ring[0][1] * Math.PI) / 180;
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos(latRad);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] * mPerDegLon;
    const yi = ring[i][1] * mPerDegLat;
    const xj = ring[j][0] * mPerDegLon;
    const yj = ring[j][1] * mPerDegLat;
    a += xj * yi - xi * yj;
  }
  return Math.abs(a / 2);
}

/** Per-building facts read off the real unit rows, when they are available. */
export interface UnitFacts {
  builtM2: number;
  unitCount: number;
}

function ownerFor(rng: () => number, useType: string, id: number): string {
  // Institutions are overwhelmingly publicly held here; housing is not.
  const publicWeight = useType === 'institutional' ? 78 : useType === 'industrial' ? 40 : 16;
  if (rng() * 100 < publicWeight) return pick(rng, PUBLIC_OWNER);
  const nameRng = rngFor('ownerName', id);
  const shape = weighted(rng, [
    ['estates', 34], ['developers', 26], ['society', 22], ['trust', 18],
  ] as const);
  switch (shape) {
    case 'estates': return `${pick(nameRng, PREFIX)} Estates Pvt Ltd`;
    case 'developers': return `${pick(nameRng, PREFIX)} Developers`;
    case 'society': return `${pick(nameRng, PREFIX)} Co-operative Housing Society`;
    case 'trust':
    default: return `${pick(nameRng, SURNAME)} Family Trust`;
  }
}

/** A Visakhapatnam-format door number, e.g. "10-2-4/a". */
function doorNumber(rng: () => number): string {
  const sector = pick(rng, [9, 10, 11] as const);
  const block = intBetween(rng, 1, 30);
  const plot = intBetween(rng, 1, 90);
  const base = `${sector}-${block}-${plot}`;
  return rng() < 0.25 ? `${base}/${pick(rng, ['a', 'b', 'c', 'd'] as const)}` : base;
}

/**
 * Enrich one building.
 *
 * `nearestStreet` is supplied by the caller so the generated address sits on a
 * street that really runs past the building rather than on an invented one.
 * `units` carries the real unit totals when the detail document is in hand.
 */
export function enrichBuilding(
  b: BuildingProps,
  opts: {
    footprint?: Ring | null;
    units?: UnitFacts | null;
    nearestStreet?: string | null;
    takenNames?: Set<string>;
  } = {},
): EnrichedBuilding {
  const { footprint, units, nearestStreet, takenNames } = opts;
  const id = b.id;
  const useType = b.use_type;
  const floors = Math.max(1, b.floors);

  const ring = (footprint?.coordinates?.[0] as number[][] | undefined) ?? undefined;
  const centre = ring ? ringCentroid(ring) : { lon: 0, lat: 0 };
  const footprintM2 = ring ? ringAreaM2(ring) : 0;

  // ---- name ---------------------------------------------------------------
  // A real OSM name is kept verbatim. Only the unnamed get a generated one.
  let name = b.name;
  let name_source: BuildingMock['name_source'] = 'osm_tag';
  if (!name) {
    name_source = 'generated';
    const rng = rngFor('name', id);
    const suffixes = suffixesFor(useType);
    let candidate = `${pick(rng, PREFIX)} ${pick(rng, suffixes)}`;
    if (takenNames) {
      // Redraw on collision, then fall back to the ULPIN's building segment.
      // The caller iterates ids in ascending order, so the outcome does not
      // depend on the FeatureCollection's ordering.
      let tries = 0;
      while (takenNames.has(candidate) && tries < 8) {
        candidate = `${pick(rng, PREFIX)} ${pick(rng, suffixes)}`;
        tries++;
      }
      if (takenNames.has(candidate)) {
        candidate = `${candidate} ${b.ulpin.split('-').pop() ?? id}`;
      }
      takenNames.add(candidate);
    }
    name = candidate;
  }

  // ---- type ---------------------------------------------------------------
  // Only ever one of the subtypes the real use_type and floor count permit.
  const building_type = pick(rngFor('type', id), subtypesFor(useType, floors));

  // ---- built-up area ------------------------------------------------------
  // The real unit sum where the detail document supplies it; otherwise a
  // footprint estimate with a circulation allowance. Both paths use the same
  // index, so the FeatureCollection and the detail document can never disagree.
  const built_up_m2 = units && units.builtM2 > 0
    ? Math.round(units.builtM2 * 10) / 10
    : Math.round(footprintM2 * floors * 0.92 * 10) / 10;

  // ---- occupancy ----------------------------------------------------------
  const occRng = rngFor('occupancy', id);
  const [lo, hi] = OCCUPANCY_BAND[useType] ?? OCCUPANCY_BAND.residential;
  const rate = lo + occRng() * (hi - lo);
  // Unit count is REAL when known; otherwise inferred from the storey count so
  // the figure still relates to the building in front of the user.
  const occupancy_total_units = units?.unitCount && units.unitCount > 0
    ? units.unitCount
    : Math.max(1, floors * (useType === 'residential' ? 4 : 2));
  const occupancy_units = Math.max(0, Math.round(occupancy_total_units * rate));
  const occupancy_persons = useType === 'residential'
    ? occupancy_units * intBetween(rngFor('household', id), 2, 5)
    : null;

  // ---- status -------------------------------------------------------------
  // One real signal overrides the draw: this AOI contains a building OSM has
  // literally tagged "Abandoned building", and calling it Occupied would be a
  // fabrication contradicting a mapped fact.
  const statusRng = rngFor('status', id);
  const status: BuildingStatus = /abandon|ruin|derelict/i.test(b.name ?? '')
    ? 'Vacant'
    : weighted(statusRng, STATUS_BY_USE[useType] ?? STATUS_BY_USE.residential);

  // ---- address ------------------------------------------------------------
  let address = b.address;
  let address_source: BuildingMock['address_source'] = 'osm_tag';
  if (!address) {
    address_source = 'generated';
    const addrRng = rngFor('addr', id);
    const street = nearestStreet ?? 'Siripuram';
    address = `${doorNumber(addrRng)}, ${street}, Siripuram, Visakhapatnam ${PIN}`;
  }

  return {
    ...b,
    name,
    address,
    building_ref: `BLD-${1000 + id}`,
    building_type,
    built_up_m2,
    occupancy_units,
    occupancy_total_units,
    occupancy_persons,
    owner_org: ownerFor(rngFor('owner', id), useType, id),
    status,
    lat: Math.round(centre.lat * 1e7) / 1e7,
    lon: Math.round(centre.lon * 1e7) / 1e7,
    name_source,
    address_source,
    mock: true,
  };
}

/**
 * Enrich a whole FeatureCollection.
 *
 * Names are assigned in ascending id order, NOT feature order, so the
 * collision-resolution outcome is a property of the data rather than of how
 * the rows happened to be returned.
 */
export function enrichCollection(
  fc: GeoFC<BuildingProps>,
  unitIndex: Map<number, UnitFacts>,
  streetFor: (lon: number, lat: number) => string | null,
): GeoFC<EnrichedBuilding> {
  const taken = new Set<string>();
  const order = fc.features
    .map((f, i) => ({ i, id: f.properties.id }))
    .sort((a, b) => a.id - b.id);

  const out: GeoFC<EnrichedBuilding>['features'] = new Array(fc.features.length);
  for (const { i } of order) {
    const f = fc.features[i];
    const ring = { type: 'Polygon', coordinates: f.geometry.coordinates } as Ring;
    const c = (f.geometry.coordinates as number[][][])[0];
    const centre = c ? ringCentroid(c) : { lon: 0, lat: 0 };
    out[i] = {
      ...f,
      properties: enrichBuilding(f.properties, {
        footprint: ring,
        units: unitIndex.get(f.properties.id) ?? null,
        nearestStreet: streetFor(centre.lon, centre.lat),
        takenNames: taken,
      }),
    };
  }
  return { ...fc, features: out };
}
