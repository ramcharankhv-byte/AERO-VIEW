import * as Cesium from 'cesium';
import {
  SUN_DATE_ISO, SUN_UTC_OFFSET_HOURS,
} from '@/lib/sun';

/**
 * Time-of-day lighting.
 *
 * ARCHITECTURE NOTE: applyGisDarkScene() pins globe.enableLighting off, because
 * lighting re-brightens the ground and undoes the dark treatment. That is still
 * the right default -- so this is the one place allowed to turn it back on, and
 * only while the user is actively holding a sun position. It must run AFTER
 * configureScene(); nothing else re-pins lighting later, so once is enough.
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
 * `hour === null` restores the boot state exactly: lighting off, shadows off.
 * Shadows are never on by default -- they cost a depth pass over every casting
 * entity, and the adaptive-resolution watchdog would quietly drop resolution to
 * pay for it.
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
  }

  // requestRenderMode is on, so none of the above repaints on its own.
  scene.requestRender();
}
