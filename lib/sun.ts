/**
 * Time-of-day constants, kept Cesium-free so the UI can import them.
 *
 * Mirrors the imagery / imagery-catalog split: lib/cesium/sun.ts does the
 * JulianDate arithmetic, this file carries the numbers and the label so that
 * LayerPanel does not pull Cesium into the chrome bundle.
 */

export const SUN_MIN_HOUR = 6;
export const SUN_MAX_HOUR = 18;
/** Where the "Noon" button lands. */
export const SUN_NOON_HOUR = 12;
export const SUN_STEP_HOURS = 0.5;

/**
 * Where the sun starts: 16:30 local, late afternoon.
 *
 * The scene boots lit rather than flat, and it boots lit from LOW. At this
 * hour on the equinox the sun sits about 20 degrees above the horizon, which
 * throws a shadow roughly three times a building's height -- long enough that
 * a six-storey block and a two-storey one are told apart by their shadows
 * before anyone reads a label, which is the whole reason the sun is on.
 *
 * Noon is the wrong default for exactly that reason: an overhead sun puts the
 * shadow under the building and the massing goes flat.
 */
export const SUN_DEFAULT_HOUR = 16.5;

/** Local time of the AOI. The sun is an illustration, not a survey instrument. */
export const SUN_UTC_OFFSET_HOURS = 5.5;

/**
 * The date the sun is computed for. Fixed on purpose: a slider that also drifted
 * with today's date would give the same hour a different sun on different days,
 * and nothing here is persisted, so there is no date to restore.
 */
export const SUN_DATE_ISO = '2026-03-21';

/** 12.5 -> "12:30". */
export function formatSunHour(h: number): string {
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
