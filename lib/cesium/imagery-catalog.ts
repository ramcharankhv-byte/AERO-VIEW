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
  | 'esri' | 'esriWayback' | 'droneOrtho' | 'mapbox'
  | 'carto' | 'cartoVoyager' | 'none';
export type TreatmentId = 'gisDark' | 'natural';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  esri: 'Esri World Imagery',
  esriWayback: 'Esri Wayback (archive)',
  droneOrtho: 'Drone orthophoto (local)',
  mapbox: 'Mapbox Satellite',
  carto: 'Dark vector (no imagery)',
  cartoVoyager: 'Light vector (CARTO Voyager)',
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

/**
 * An optional CARTO API key.
 *
 * OPTIONAL, and the basemaps work without it -- this is not a provider that
 * needs a token. CARTO has begun stamping "API KEY REQUIRED" across every
 * anonymous basemap tile, INCLUDING the dark_all style this application has
 * shipped since before the 2D view existed, so the watermark is a property of
 * the service now rather than of any one provider here. Setting
 * NEXT_PUBLIC_CARTO_API_KEY removes it; leaving it unset leaves a usable,
 * correctly attributed, watermarked map, which is what the repository has been
 * serving all along.
 *
 * Read as a full literal for the reason MAPBOX_TOKEN documents above: a
 * computed process.env lookup is not inlined by Next and silently yields
 * undefined.
 */
export const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY?.trim() ?? '';

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
 *
 * cartoVoyager is LISTED even though the 2D GIS view selects it on its own.
 * Hiding it would leave the dropdown with no option matching its own value
 * whenever that view is on, and a <select> whose value is not among its
 * options renders blank -- the control would look broken at exactly the moment
 * it is telling the truth. It is also a perfectly good basemap to pick by hand.
 */
export function availableProviders(): { id: ProviderId; label: string }[] {
  const ids: ProviderId[] = ['esri', 'esriWayback'];
  if (hasDroneOrtho()) ids.push('droneOrtho');
  if (hasMapboxToken()) ids.push('mapbox');
  ids.push('carto', 'cartoVoyager', 'none');
  return ids.map((id) => ({ id, label: PROVIDER_LABELS[id] }));
}
