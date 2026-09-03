import * as Cesium from 'cesium';
import {
  SUN_DATE_ISO, SUN_UTC_OFFSET_HOURS,
} from '@/lib/sun';

/**
 * Time-of-day lighting.
 *
 * ARCHITECTURE NOTE: applyGisDarkScene() pins globe.enableLighting off, and
 * this is still the ONE place allowed to turn it back on. The difference from
 * before is only the default: the store boots at SUN_DEFAULT_HOUR, so the
 * first call after configureScene() lights the scene instead of leaving it
 * flat. Order still matters -- this must run after configureScene(); nothing
 * else re-pins lighting later, so once is enough.
 */

/** Local AOI hour (6-18) -> the instant Cesium should light the globe for. */
export function julianForHour(hour: number): Cesium.JulianDate {
  const [y, m, d] = SUN_DATE_ISO.split('-').map(Number);
  const utcHour = hour - SUN_UTC_OFFSET_HOURS;
  const whole = Math.floor(utcHour);
  const minutes = Math.round((utcHour - whole) * 60);
  return Cesium.JulianDate.fromDate(new Date(Date.UTC(y, m - 1, d, whole, minutes, 0)));
}

/**
 * Apply (or fully undo) the sun.
 *
 * `hour === null` is the flat, unlit scene: no lighting, no shadows, and no
 * depth pass over every casting entity. It is the cheap path and the slider's
 * off position, and it is what the adaptive-resolution watchdog can fall back
 * to -- it is simply no longer where the app starts.
 */
export function applySun(
  viewer: Cesium.Viewer,
  hour: number | null,
  lowEnd: boolean,
): void {
  const scene = viewer.scene;

  if (hour === null) {
    scene.globe.enableLighting = false;
    viewer.shadows = false;
  } else {
    viewer.clock.currentTime = julianForHour(hour);
    scene.globe.enableLighting = true;
    viewer.shadows = true;
    // A soft, small map: this is a legibility cue for massing, not a study.
    scene.shadowMap.size = lowEnd ? 1024 : 2048;
    scene.shadowMap.softShadows = !lowEnd;
    scene.shadowMap.maximumDistance = 4000;
    // Softened. A 16:30 sun throws a shadow three times the building's height,
    // so about a third of the ground in a dense block ends up shadowed
    // (measured, not guessed); at full strength that third goes to mud and
    // takes the basemap's detail with it. 0.35 keeps the shadow saying
    // "something tall is here" while the plot it falls across stays readable.
    scene.shadowMap.darkness = 0.35;
    // globe.lambertDiffuseMultiplier is deliberately left alone.
    //
    // Raising it to compensate for the low sun looks like the right knob and
    // is not: it multiplies the diffuse term AFTER the shadow term has been
    // folded in, so by ~1.7 both lit and shadowed ground clamp to the same
    // value and the shadows disappear entirely -- the exact thing the sun was
    // turned on for. Exposure is the imagery treatment's job (TREATMENTS in
    // lib/cesium/imagery.ts), and it is applied before lighting, so darkening
    // there keeps the shadow contrast intact.
  }

  // requestRenderMode is on, so none of the above repaints on its own.
  scene.requestRender();
}
