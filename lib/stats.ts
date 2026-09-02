/**
 * Aggregations behind the mini-dashboard.
 *
 * Pure and Cesium-free so the numbers are computed from the loaded cadastre
 * rather than written down: every figure the StatsPanel prints comes from one
 * of these functions, including the provenance percentages in the captions.
 */

import type {
  BuildingProps, ConflictRow, GeoFeature, Provenance, UseType,
} from './types';

export const USE_TYPES: UseType[] = [
  'residential', 'commercial', 'institutional', 'industrial',
];

export const PROVENANCES: Provenance[] = [
  'osm_tag', 'surveyed_plan', 'dsm_dem', 'estimated',
];

export interface Bin {
  /** Inclusive lower edge, in metres. */
  lo: number;
  /** Exclusive upper edge, except for the last bin which is inclusive. */
  hi: number;
  count: number;
}

/**
 * Equal-width bins over height_m.
 *
 * The AOI's heights are quantised (always floors x 3.2 m), so bin edges are
 * reported rather than rounded away -- a bin chart that hid the quantisation
 * would imply a continuous measurement that was never taken.
 */
export function heightHistogram(
  features: GeoFeature<BuildingProps>[],
  bins = 8,
): Bin[] {
  if (features.length === 0 || bins < 1) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const f of features) {
    const h = f.properties.height_m;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  // A degenerate range would divide by zero; one bin holding everything is the
  // honest rendering of "every building is the same height".
  const width = max > min ? (max - min) / bins : 1;
  const out: Bin[] = Array.from({ length: bins }, (_, i) => ({
    lo: min + i * width,
    hi: min + (i + 1) * width,
    count: 0,
  }));
  for (const f of features) {
    const idx = Math.min(bins - 1, Math.floor((f.properties.height_m - min) / width));
    out[idx].count++;
  }
  return out;
}

/** Building counts per use_type, in a fixed order so the bars never reorder. */
export function useTypeCounts(
  features: GeoFeature<BuildingProps>[],
): Array<{ key: UseType; count: number }> {
  const tally = new Map<string, number>();
  for (const f of features) {
    const k = f.properties.use_type;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  return USE_TYPES.map((key) => ({ key, count: tally.get(key) ?? 0 }));
}

/** Conflict counts per utility authority, busiest first. */
export function conflictsByAuthority(
  rows: ConflictRow[],
): Array<{ key: string; count: number }> {
  const tally = new Map<string, number>();
  for (const r of rows) {
    tally.set(r.authority, (tally.get(r.authority) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface ProvenanceMix {
  counts: Record<Provenance, number>;
  /** Whole percentages of the total, for the captions. */
  pct: Record<Provenance, number>;
  /** Buildings whose "surveyed" height came from a self-declared demo register. */
  synthetic: number;
  total: number;
}

/** The height_source split, which is the caption on every chart. */
export function provenanceMix(features: GeoFeature<BuildingProps>[]): ProvenanceMix {
  const counts = { osm_tag: 0, surveyed_plan: 0, dsm_dem: 0, estimated: 0 };
  let synthetic = 0;
  for (const f of features) {
    const src = f.properties.height_source;
    if (src in counts) counts[src]++;
    if (f.properties.survey_synthetic) synthetic++;
  }
  const total = features.length;
  const pct = { osm_tag: 0, surveyed_plan: 0, dsm_dem: 0, estimated: 0 };
  for (const p of PROVENANCES) {
    pct[p] = total === 0 ? 0 : Math.round((counts[p] / total) * 100);
  }
  return { counts, pct, synthetic, total };
}
