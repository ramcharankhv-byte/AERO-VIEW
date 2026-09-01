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

export const TREATMENTS: Record<TreatmentId, Treatment> = {
  // Default. Pushes the imagery back so it reads as context beneath the
  // building geometry: dark, largely desaturated, contrast lifted just enough
  // that roads and plot edges survive the dimming.
  gisDark: {
    brightness: 0.55,
    saturation: 0.35,
    contrast: 1.15,
    gamma: 1.0,
    hue: 0.0,
  },
  // Raw imagery, for when a reviewer asks to see what the source looks like.
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
 * pulled down to match. Lighting stays off and HDR stays off: both would
 * re-brighten the ground and undo the treatment.
 */
export function applyGisDarkScene(scene: Cesium.Scene): void {
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1219');
  scene.fog.enabled = true;
  scene.fog.density = 0.0002;
  scene.skyAtmosphere.brightnessShift = -0.35;
  scene.skyAtmosphere.saturationShift = -0.3;
  scene.globe.enableLighting = false;
  scene.highDynamicRange = false;
}
