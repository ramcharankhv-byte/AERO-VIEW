/**
 * ISRO Bhuvan WMS: the Cesium-free half.
 *
 * URL builders, the GetFeatureInfo parsers and the labels the chrome shows.
 * Deliberately free of Cesium and React so LayerPanel, Legend, DetailPanel and
 * the store can import it (they are prerendered; Cesium touches `window` at
 * module scope). The ImageryLayer construction lives in lib/cesium/imagery.ts.
 *
 * Bhuvan's vector server answers with `Access-Control-Allow-Origin: *`, so
 * everything here talks to it directly; there is no proxy route.
 *
 * WMS 1.3.0 + EPSG:4326 puts LATITUDE FIRST: BBOX is south,west,north,east.
 * Cesium's provider flips its own GetMap template for this CRS; the manual
 * GetFeatureInfo request below builds the bbox in that order itself.
 */
import type { BhuvanLayers, LayerKey } from './types';

export const BHUVAN_WMS_URL = 'https://bhuvan-vec2.nrsc.gov.in/bhuvan/ows';
export const BHUVAN_CREDIT = '© NRSC/ISRO Bhuvan';

export type BhuvanKind = keyof BhuvanLayers;
export const BHUVAN_KINDS: BhuvanKind[] = ['lulc', 'flood', 'cyclone'];

export const BHUVAN_LABEL: Record<BhuvanKind, string> = {
  lulc: 'Land use (SISDP 1:10k)',
  flood: 'Flood hazard zones',
  cyclone: 'Cyclone hazard zones',
};

/** Which view-store layer flag each overlay is switched by. */
export const BHUVAN_LAYER_KEY: Record<BhuvanKind, LayerKey> = {
  lulc: 'bhuvanLulc',
  flood: 'bhuvanFlood',
  cyclone: 'bhuvanCyclone',
};

export const LULC_SOURCE_SHORT = 'SISDP 1:10k (Bhuvan)';

export const LULC_NOTE =
  'LULC is SISDP 1:10,000 (2016–19); flood and cyclone zones are national-scale '
  + 'and coarse relative to building footprints.';

/** One LULC classification at a point. */
export interface LulcResult {
  /** SISDP level code, e.g. "BUUC". */
  code: string;
  /** The class the map is coloured by, e.g. "Built up (Urban)". */
  cls: string;
  /** The finer term when it adds a word, e.g. "Core urban"; else null. */
  detail: string | null;
}

// GetFeatureInfo window: 800x700 px over a ~110 m box centred on the point,
// so I/J are always the centre pixel and one pixel is ~0.14 m. The longitude
// half-width keeps the pixels square in metres.
const GFI_W = 800;
const GFI_H = 700;
const GFI_HALF_LAT = 0.0005;

export function buildGetFeatureInfoUrl(
  layer: string,
  lon: number,
  lat: number,
  infoFormat = 'application/json',
): string {
  const halfLat = GFI_HALF_LAT;
  const halfLon = (halfLat * GFI_W / GFI_H) / Math.cos((lat * Math.PI) / 180);
  const south = lat - halfLat;
  const north = lat + halfLat;
  const west = lon - halfLon;
  const east = lon + halfLon;
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetFeatureInfo',
    LAYERS: layer,
    QUERY_LAYERS: layer,
    STYLES: '',
    FORMAT: 'image/png',
    CRS: 'EPSG:4326',
    // lat,lon axis order for EPSG:4326 under WMS 1.3.0.
    BBOX: [south, west, north, east].map((v) => v.toFixed(7)).join(','),
    WIDTH: String(GFI_W),
    HEIGHT: String(GFI_H),
    I: String(GFI_W / 2),
    J: String(GFI_H / 2),
    INFO_FORMAT: infoFormat,
    FEATURE_COUNT: '1',
  });
  return `${BHUVAN_WMS_URL}?${q.toString()}`;
}

export function buildLegendUrl(layer: string): string {
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetLegendGraphic',
    FORMAT: 'image/png',
    LAYER: layer,
  });
  return `${BHUVAN_WMS_URL}?${q.toString()}`;
}

function str(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}

function result(code: string, cls: string, d3: string): LulcResult | null {
  if (!cls) return null;
  return { code, cls, detail: d3 && d3 !== cls ? d3 : null };
}

/**
 * GeoServer JSON: features[0].properties = { lc_code, dscr1, dscr2, dscr3 }.
 *
 * dscr2 ("Built up (Urban)") is the class the map is coloured by, so it is the
 * class shown; dscr3 ("Core urban") is appended when it adds a word; dscr1 is
 * the level-1 fallback. Returns null for "no feature at this point"; throws
 * when the body is not a FeatureCollection so the caller can try text/html.
 */
export function parseFeatureInfoJson(json: unknown): LulcResult | null {
  const fc = json as {
    type?: string;
    features?: Array<{ properties?: Record<string, unknown> }>;
  } | null;
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('GetFeatureInfo: not a FeatureCollection');
  }
  const p = fc.features[0]?.properties;
  if (!p) return null;
  const cls = str(p.dscr2) || str(p.dscr1);
  return result(str(p.lc_code), cls, str(p.dscr3));
}

/**
 * GeoServer's default text/html template: one <table class="featureInfo">
 * with a <th> row of property names and one <td> row per feature.
 */
export function parseFeatureInfoHtml(html: string): LulcResult | null {
  const cells = (row: string): string[] =>
    [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => cells(m[1]));
  const head = rows.find((r) => r.some((c) => /^dscr2$/i.test(c)));
  if (!head) return null;
  const body = rows.find((r) => r !== head && r.length === head.length && r.some(Boolean));
  if (!body) return null;
  const get = (k: string): string => {
    const i = head.findIndex((c) => c.toLowerCase() === k);
    return i < 0 ? '' : body[i] ?? '';
  };
  const cls = get('dscr2') || get('dscr1');
  return result(get('lc_code'), cls, get('dscr3'));
}

/** "Built up (Urban), Core urban" */
export function lulcClassLabel(r: LulcResult): string {
  return r.detail ? `${r.cls}, ${r.detail}` : r.cls;
}

/** The full line: "LULC: Built up (Urban), Core urban — SISDP 1:10k (Bhuvan)". */
export function formatLulcLine(r: LulcResult): string {
  return `LULC: ${lulcClassLabel(r)} — ${LULC_SOURCE_SHORT}`;
}

/**
 * Look the LULC class up at a point. JSON first; text/html if the server
 * answered with anything else. Resolves null when no feature covers the
 * point; rejects on network failure or abort.
 */
export async function fetchLulcAt(
  layer: string,
  lon: number,
  lat: number,
  signal: AbortSignal,
): Promise<LulcResult | null> {
  const res = await fetch(buildGetFeatureInfoUrl(layer, lon, lat), { signal, mode: 'cors' });
  if (res.ok) {
    const text = await res.text();
    try {
      return parseFeatureInfoJson(JSON.parse(text));
    } catch {
      /* not JSON, or not a FeatureCollection: fall through to text/html */
    }
  }
  const res2 = await fetch(
    buildGetFeatureInfoUrl(layer, lon, lat, 'text/html'),
    { signal, mode: 'cors' },
  );
  if (!res2.ok) throw new Error(`GetFeatureInfo ${res2.status}`);
  return parseFeatureInfoHtml(await res2.text());
}
