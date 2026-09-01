/**
 * The imagery catalogue: ids, labels, and which providers are offered.
 *
 * Deliberately free of any Cesium import. LayerPanel is a plain client
 * component that Next still prerenders on the server, and Cesium touches
 * `window` at module evaluation time -- importing imagery.ts from the UI would
 * throw during prerender, which is the same reason Scene is loaded with
 * ssr:false. The provider construction that does need Cesium lives next door
 * in imagery.ts, which re-exports these names so callers have one entry point.
 */

export type ProviderId =
  | 'esri' | 'esriWayback' | 'droneOrtho' | 'mapbox' | 'carto' | 'none';
export type TreatmentId = 'gisDark' | 'natural';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  esri: 'Esri World Imagery',
  esriWayback: 'Esri Wayback (archive)',
  droneOrtho: 'Drone orthophoto (local)',
  mapbox: 'Mapbox Satellite',
  carto: 'Dark vector (no imagery)',
  none: 'None',
};

export const TREATMENT_LABELS: Record<TreatmentId, string> = {
  natural: 'Natural',
  gisDark: 'GIS dark',
};

/**
 * Read as a full literal so Next inlines it at build time. A computed lookup
 * such as process.env[name] is not substituted and silently yields undefined.
 */
export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? '';

/**
 * XYZ tile template for a drone orthophoto flown over the AOI, e.g.
 * `/ortho/{z}/{x}/{y}.png` for a tile pyramid served out of /public. Unset in
 * every deployment that has no flight, which is the normal case -- hence the
 * same treatment as Mapbox rather than a placeholder entry that 404s.
 */
export const DRONE_ORTHO_URL = process.env.NEXT_PUBLIC_DRONE_ORTHO_URL?.trim() ?? '';

/** Attribution for the ortho. A survey product must say who flew it. */
export const DRONE_ORTHO_CREDIT =
  process.env.NEXT_PUBLIC_DRONE_ORTHO_CREDIT?.trim() || 'Drone orthophoto (local survey)';

export function hasMapboxToken(): boolean {
  return MAPBOX_TOKEN.length > 0;
}

/** True when a drone ortho tile pyramid has been configured for this AOI. */
export function hasDroneOrtho(): boolean {
  return DRONE_ORTHO_URL.length > 0;
}

/**
 * The dropdown's contents. Mapbox and the drone ortho are omitted entirely
 * when unconfigured -- an option that cannot work is worse than no option.
 * The ortho sits directly under Esri: when a local flight exists it is the
 * better ground truth, so it belongs beside the global mosaic, not below the
 * fallbacks.
 */
export function availableProviders(): { id: ProviderId; label: string }[] {
  const ids: ProviderId[] = ['esri', 'esriWayback'];
  if (hasDroneOrtho()) ids.push('droneOrtho');
  if (hasMapboxToken()) ids.push('mapbox');
  ids.push('carto', 'none');
  return ids.map((id) => ({ id, label: PROVIDER_LABELS[id] }));
}
