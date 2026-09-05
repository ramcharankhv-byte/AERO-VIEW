'use client';

/**
 * Basemap imagery: the provider registry and the colour treatment.
 *
 * Two ideas live here and they are deliberately separate.
 *
 * The REGISTRY is a set of async thunks. Nothing is constructed at module
 * scope -- a provider only exists once it has been selected, which keeps the
 * network quiet for the four providers the user is not looking at. Every
 * failure path funnels through createImageryLayer() and lands on CARTO, so
 * the globe is never left untextured by accident.
 *
 * The TREATMENT is the cheap fix for a basemap that competes with the
 * geometry. Cesium exposes brightness/contrast/saturation/gamma/hue as plain
 * mutable properties on ImageryLayer, so switching tone is an assignment, not
 * a rebuild. Buildings are unlit (see configureScene) and stay bright; only
 * the imagery is dimmed. The contrast between the two is the entire point --
 * do not dim lib/cesium/materials.ts to match.
 */
import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { DRONE_ORTHO_CREDIT, DRONE_ORTHO_URL, MAPBOX_TOKEN } from './imagery-catalog';
import type { ProviderId, TreatmentId } from './imagery-catalog';
import { BHUVAN_CREDIT, BHUVAN_WMS_URL, type BhuvanKind } from '@/lib/bhuvan';

// Re-exported so this module stays the single entry point for imagery, even
// though the Cesium-free half of it lives in imagery-catalog.ts.
export type { ProviderId, TreatmentId };
export {
  availableProviders, hasDroneOrtho, hasMapboxToken,
  PROVIDER_LABELS, TREATMENT_LABELS,
} from './imagery-catalog';

/**
 * Wayback release number for the AOI.
 *
 * There is no API for "the best archive layer over Siripuram" -- releases are
 * global snapshots and most of them have no better coverage here than the
 * current mosaic. Pick one by hand from the Wayback app
 * (https://livingatlas.arcgis.com/wayback), pan to the AOI, find a release
 * whose imagery you actually want, and paste its release number here.
 *
 * Left null, the 'esriWayback' entry resolves to current Esri World Imagery
 * rather than requesting tiles from a release that does not exist.
 */
export const WAYBACK_RELEASE: number | null = null;

const ESRI_WORLD_IMAGERY =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';

/**
 * The AOI, restated here rather than imported from setup.ts: setup.ts already
 * imports applyGisDarkScene from this module, and importing back would close a
 * cycle. Only the drone ortho uses it -- every other provider is global.
 */
const AOI_RECT = { west: 83.313, south: 17.718, east: 83.3245, north: 17.728 };

const WAYBACK_TEMPLATE =
  'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0'
  + '/default028mm/MapServer/tile/{RELEASE}/{z}/{y}/{x}';

interface ProviderEntry {
  create: () => Promise<Cesium.ImageryProvider>;
}

/**
 * The registry. Keyed by everything except 'none', which is the absence of a
 * layer rather than a provider and is handled in createImageryLayer.
 */
const REGISTRY: Record<Exclude<ProviderId, 'none'>, ProviderEntry> = {
  esri: {
    create: () =>
      Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY, {
        enablePickFeatures: false,
        // Cesium ignores an explicit credit for a tiled MapServer and uses the
        // service's own copyrightText instead -- which carries the same Esri /
        // Maxar / Earthstar attribution. Passed anyway so the licence string
        // is stated in our source rather than only arriving over the wire.
        credit: new Cesium.Credit(
          'Esri, Maxar, Earthstar Geographics, GIS User Community',
        ),
      }),
  },

  esriWayback: {
    create: async () => {
      // No release chosen: current imagery is the honest answer, and it is
      // what the Wayback app itself shows you before you pick a date.
      if (WAYBACK_RELEASE === null) return REGISTRY.esri.create();
      return new Cesium.UrlTemplateImageryProvider({
        url: WAYBACK_TEMPLATE,
        // {RELEASE} is an ArcGIS convention, not one of Cesium's built-in
        // template keywords; without this it is sent through literally and
        // every tile 404s.
        customTags: { RELEASE: () => String(WAYBACK_RELEASE) },
        credit: new Cesium.Credit('Esri World Imagery Wayback'),
        maximumLevel: 19,
      });
    },
  },

  droneOrtho: {
    create: async () => {
      if (!DRONE_ORTHO_URL) throw new Error('NEXT_PUBLIC_DRONE_ORTHO_URL is not set');
      return new Cesium.UrlTemplateImageryProvider({
        url: DRONE_ORTHO_URL,
        credit: new Cesium.Credit(DRONE_ORTHO_CREDIT),
        // A flight covers the AOI and nothing else. Bounding the provider to
        // the AOI stops Cesium requesting tiles for the rest of the world and
        // filling the view with 404s outside the surveyed strip.
        rectangle: Cesium.Rectangle.fromDegrees(
          AOI_RECT.west, AOI_RECT.south, AOI_RECT.east, AOI_RECT.north,
        ),
        // Ortho pyramids are shallow; 22 is about 3 cm/px at this latitude.
        maximumLevel: 22,
      });
    },
  },

  mapbox: {
    create: async () => {
      if (!MAPBOX_TOKEN) throw new Error('NEXT_PUBLIC_MAPBOX_TOKEN is not set');
      return new Cesium.UrlTemplateImageryProvider({
        url:
          'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90'
          + `?access_token=${MAPBOX_TOKEN}`,
        credit: new Cesium.Credit('© Mapbox © Maxar'),
        maximumLevel: 19,
      });
    },
  },

  carto: {
    create: async () =>
      new Cesium.UrlTemplateImageryProvider({
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        subdomains: ['a', 'b', 'c'],
        // {r} is CARTO's retina slot, a Leaflet convention Cesium does not
        // know. Resolve it here or the literal "{r}" reaches the CDN.
        customTags: {
          r: () =>
            typeof window !== 'undefined' && window.devicePixelRatio > 1 ? '@2x' : '',
        },
        credit: new Cesium.Credit('© CARTO © OpenStreetMap contributors'),
        maximumLevel: 20,
      }),
  },
};

/**
 * Build the layer for a provider, falling back to CARTO on any failure.
 *
 * Returns the id that was actually used, which is not always the one asked
 * for -- the caller reports that rather than silently showing the wrong
 * basemap under the right label.
 */
export async function createImageryLayer(
  id: ProviderId,
): Promise<{ id: ProviderId; layer: Cesium.ImageryLayer | null }> {
  if (id === 'none') return { id: 'none', layer: null };

  try {
    const provider = await REGISTRY[id].create();
    return { id, layer: new Cesium.ImageryLayer(provider) };
  } catch (err) {
    console.warn(
      `[imagery] provider "${id}" failed to load, falling back to carto:`,
      err,
    );
  }

  if (id !== 'carto') {
    try {
      const provider = await REGISTRY.carto.create();
      return { id: 'carto', layer: new Cesium.ImageryLayer(provider) };
    } catch (err) {
      console.warn('[imagery] carto fallback also failed:', err);
    }
  }

  // Both gone. The globe still paints its baseColor, so this degrades to the
  // 'none' look rather than to nothing at all.
  return { id: 'none', layer: null };
}

interface Treatment {
  brightness: number;
  saturation: number;
  contrast: number;
  gamma: number;
  hue: number;
}

/**
 * THE BASEMAP KEEPS ITS COLOUR. Vegetation reads green, tin roofs read blue,
 * bare plots read ochre -- that is what makes a satellite image legible as
 * ground, and stripping it turned the AOI into a grey smear.
 *
 * Black is for the CHROME only (top bar, dock, panels -- see
 * app/globals.css). The two treatments therefore differ by EXPOSURE, not by
 * hue: how far the imagery is pushed back behind the building geometry.
 *
 * The imagery itself is untouched at source; this is a display transform on
 * the layer, so the attribution obligations are unaffected.
 */
export const TREATMENTS: Record<TreatmentId, Treatment> = {
  // Default. Pushes the imagery back so it reads as ground beneath the
  // building masses, and pushes it GREEN: this AOI is dense vegetation, so
  // dimming the exposure while lifting saturation lands the terrain on a deep
  // green that the neutral off-white buildings separate from by value AND by
  // chroma at once. That double separation is what lets the buildings sit at
  // 45% opacity and still read as objects rather than as haze.
  //
  // Gamma < 1 keeps shadow detail: with a low sun the ground is already half
  // in shadow, and pure darkening crushed the AOI's lane pattern to a wash.
  // Contrast is lifted just enough that roads and plot edges survive both.
  gisDark: {
    brightness: 1.0,
    saturation: 1.45,
    contrast: 1.1,
    gamma: 0.94,
    hue: 0.0,
  },
  // Full-exposure imagery, exactly as the provider serves it.
  natural: {
    brightness: 1.0,
    saturation: 1.0,
    contrast: 1.0,
    gamma: 1.0,
    hue: 0.0,
  },
};

/** Retone a live layer. Callable at runtime; never recreates the layer. */
export function applyTreatment(layer: Cesium.ImageryLayer, treatment: TreatmentId): void {
  const t = TREATMENTS[treatment];
  layer.brightness = t.brightness;
  layer.saturation = t.saturation;
  layer.contrast = t.contrast;
  layer.gamma = t.gamma;
  layer.hue = t.hue;
}

/**
 * The scene half of the gisDark treatment.
 *
 * Dimming the imagery layer alone leaves an untextured globe and a horizon
 * that are both too bright for it, so the base colour, fog and atmosphere are
 * pulled down to match -- pulled DOWN, not drained: the sky keeps its hue for
 * the same reason the ground does.
 *
 * Lighting is pinned OFF here and HDR stays off, but read that narrowly: HDR
 * would re-brighten the ground and undo the exposure, while lighting is simply
 * not this function's to set. lib/cesium/sun.ts owns it, runs immediately
 * after configureScene(), and turns it back on at SUN_DEFAULT_HOUR -- so the
 * scene you actually see is this treatment under a low afternoon sun.
 */
export function applyGisDarkScene(scene: Cesium.Scene): void {
  // What shows through before a tile lands. Green, so the gap reads as ground
  // rather than as a hole in the mosaic -- but dark, because at city altitude
  // the un-tiled wedge is large and anything lighter glows through it.
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0D1710');
  scene.fog.enabled = true;
  scene.fog.density = 0.0002;
  scene.skyAtmosphere.brightnessShift = -0.2;
  // Left at 0. The horizon band belongs to the scene, not to the chrome.
  scene.skyAtmosphere.saturationShift = 0.0;
  scene.globe.enableLighting = false;
  scene.highDynamicRange = false;
}

// ---------------------------------------------------------------------------
// ISRO Bhuvan WMS overlays.
//
// Not basemaps: they are drawn ABOVE layer 0 and switched independently of
// it. Bhuvan's vector server carries no imagery, so it is never offered in
// the provider registry above. Construction lives here because this module
// is the single entry point for imagery; the URL builders, labels and the
// GetFeatureInfo parser are Cesium-free and live in lib/bhuvan.ts.
// ---------------------------------------------------------------------------

/**
 * Opacity of each overlay over the basemap. An ImageryLayer alpha is a layer
 * knob like the brightness and saturation in TREATMENTS, not a Cesium.Color,
 * which is why it lives here and not in materials.ts.
 *
 * All three are backdrops, and all three are deliberately faint. Every one of
 * these layers returns a SINGLE class over an AOI 1.2 km across -- the ward is
 * uniformly built-up, and the hazard zones are national-scale -- so at any
 * strength they are a flat wash that hides the map without telling the reader
 * anything about which street is worse than which. The differentiation comes
 * from the derived grading drawn on top (components/layers/HazardRiskLayer);
 * these say "and the national dataset puts all of this in one class", which is
 * worth showing and not worth shouting.
 */
export const BHUVAN_ALPHA: Record<BhuvanKind, number> = { lulc: 0.3, flood: 0.25, cyclone: 0.25 };

/** ~0.6 m/px on a geographic scheme; SISDP 1:10k has nothing finer to show. */
const BHUVAN_MAX_LEVEL = 18;

/**
 * The highest level at which the rectangle spans at most four tiles.
 *
 * Cesium refuses a minimumLevel whose rectangle covers more, and anything
 * lower would ask the WMS to render a whole state into one 256 px tile for
 * every coarse globe tile the camera can see.
 */
function minimumLevelFor(scheme: Cesium.GeographicTilingScheme, rect: Cesium.Rectangle): number {
  const sw = Cesium.Rectangle.southwest(rect);
  const ne = Cesium.Rectangle.northeast(rect);
  for (let level = 12; level > 0; level--) {
    const a = scheme.positionToTileXY(sw, level);
    const b = scheme.positionToTileXY(ne, level);
    if (a && b && (Math.abs(b.x - a.x) + 1) * (Math.abs(b.y - a.y) + 1) <= 4) return level;
  }
  return 0;
}

/**
 * One Bhuvan overlay as an ImageryLayer, hidden and at the kind's alpha.
 *
 * WMS 1.3.0 with EPSG:4326: Cesium flips the GetMap BBOX template to
 * south,west,north,east itself for this CRS (WebMapServiceImageryProvider's
 * reverse-axis list), so `crs` is set and `srs` deliberately is not.
 * `bbox` is west,south,east,north as the project row carries it.
 */
export function createBhuvanLayer(
  kind: BhuvanKind,
  layerName: string,
  bbox: readonly [number, number, number, number],
): Cesium.ImageryLayer {
  const [w, s, e, n] = bbox;
  // A quarter-bbox of context past the AOI edge; beyond that no tiles are
  // requested, so a wide zoom-out never fans into state-wide GetMap calls.
  const padLon = (e - w) * 0.25;
  const padLat = (n - s) * 0.25;
  const rectangle = Cesium.Rectangle.fromDegrees(w - padLon, s - padLat, e + padLon, n + padLat);
  const tilingScheme = new Cesium.GeographicTilingScheme();
  const provider = new Cesium.WebMapServiceImageryProvider({
    url: BHUVAN_WMS_URL,
    layers: layerName,
    parameters: {
      service: 'WMS',
      version: '1.3.0',
      request: 'GetMap',
      format: 'image/png',
      transparent: true,
      styles: '',
    },
    crs: 'EPSG:4326',
    tilingScheme,
    rectangle,
    tileWidth: 256,
    tileHeight: 256,
    minimumLevel: minimumLevelFor(tilingScheme, rectangle),
    maximumLevel: BHUVAN_MAX_LEVEL,
    // GetFeatureInfo is done once per building click by lib/bhuvan.ts, not
    // on every scene pick.
    enablePickFeatures: false,
    credit: new Cesium.Credit(BHUVAN_CREDIT),
  });
  return new Cesium.ImageryLayer(provider, {
    alpha: BHUVAN_ALPHA[kind],
    show: false,
    rectangle,
  });
}
