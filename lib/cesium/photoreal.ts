'use client';

/**
 * Google Photorealistic 3D Tiles.
 *
 * The tileset is a scene PRIMITIVE, not a data source -- it is the only thing
 * in this app that is, because 3D Tiles have no Entity representation. It is
 * created lazily (nothing is requested while the user is in Schematic mode)
 * and destroyed on the way back out, so a session that never touches Photoreal
 * never spends a byte of Google quota.
 *
 * Access is via Cesium ion by default: with `NEXT_PUBLIC_CESIUM_TOKEN` set,
 * ion brokers the Google session and no Google key is needed. Supplying
 * `NEXT_PUBLIC_GOOGLE_MAPS_KEY` bypasses ion and bills the key directly.
 */
import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';

/**
 * Read as full literals so Next inlines them at build time. A computed lookup
 * such as process.env[name] is not substituted and silently yields undefined
 * (same reasoning as MAPBOX_TOKEN in imagery-catalog.ts).
 */
export const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY?.trim() ?? '';

/**
 * Build the tileset. Throws on quota, auth or network failure -- the caller
 * turns that into a toast and falls back to Schematic, so there is no silent
 * "Photoreal is on but nothing loaded" state.
 */
export async function createPhotorealTileset(): Promise<Cesium.Cesium3DTileset> {
  // The viewer is constructed with `geocoder: false`, so we genuinely do not
  // use any geocoder with these tiles. Asserting it suppresses Cesium's
  // one-time console warning rather than merely silencing a real caveat.
  const apiOptions: { key?: string; onlyUsingWithGoogleGeocoder?: true } = {
    onlyUsingWithGoogleGeocoder: true,
  };
  if (GOOGLE_MAPS_KEY) apiOptions.key = GOOGLE_MAPS_KEY;

  return Cesium.createGooglePhotorealistic3DTileset(apiOptions, {
    // The AOI is ~1 km across and the camera sits between 40 m and 6 km, so
    // the default error budget is more tiles than this view can use.
    maximumScreenSpaceError: 16,
    // Google's attribution is a licence obligation. Cesium renders it into
    // the credit container, which globals.css already keeps clear of the
    // StatusBar.
    showCreditsOnScreen: true,
  });
}

/**
 * Underground mode has to see through the tiles the same way it sees through
 * the globe. `globe.translucency` cannot help here -- these are primitives,
 * not the globe -- so the equivalent is a tileset style that multiplies every
 * feature's alpha down.
 */
export function applyPhotorealTranslucency(
  tileset: Cesium.Cesium3DTileset,
  underground: boolean,
): void {
  tileset.style = underground
    ? new Cesium.Cesium3DTileStyle({ color: 'color("white", 0.25)' })
    : undefined;
}

/** Human-readable reason for the toast. Quota and auth are the likely two. */
export function photorealFailureMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/401|403|unauthor|forbidden|token/i.test(text)) {
    return 'Cesium ion rejected the request for Google Photorealistic 3D Tiles. Check NEXT_PUBLIC_CESIUM_TOKEN, or set NEXT_PUBLIC_GOOGLE_MAPS_KEY to bill a Google key directly.';
  }
  if (/429|quota|rate|limit/i.test(text)) {
    return 'Google Photorealistic 3D Tiles hit a quota or rate limit.';
  }
  return `Google Photorealistic 3D Tiles failed to load: ${text}`;
}
