/**
 * Sets CESIUM_BASE_URL before the Cesium module is ever evaluated.
 *
 * Import this module BEFORE `import * as Cesium from 'cesium'` in any file that
 * touches Cesium. ES module bodies execute in import order, so putting this
 * first guarantees the global is in place by the time Cesium's own module body
 * runs and captures it for worker/asset resolution.
 *
 * The assets themselves are copied into public/cesium by scripts/copy-cesium.mjs
 * on postinstall.
 */
declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}

if (typeof window !== 'undefined' && !window.CESIUM_BASE_URL) {
  window.CESIUM_BASE_URL = '/cesium';
}

export {};
