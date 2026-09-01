/**
 * Cesium note
 * -----------
 * Cesium 1.126 imports '@zip.js/zip.js/lib/zip-no-worker.js'. That subpath
 * exists in zip.js 2.7.x but was removed in 2.9.x, and Cesium's own dependency
 * range (^2.7.34) happily resolves to the newer, incompatible release -- which
 * fails the build on KmlDataSource / exportKml with an unresolvable module.
 * package.json pins it back through an `overrides` entry, so Cesium's normal ES
 * source entry point resolves cleanly and no bundler alias is needed here.
 *
 * Static assets (workers, Assets/, Widgets/) are copied to public/cesium by
 * scripts/copy-cesium.mjs on postinstall, and lib/cesium/base-url.ts sets
 * CESIUM_BASE_URL to that directory before Cesium is ever evaluated.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Cesium's Viewer does not tolerate double-mount in dev
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // Cesium probes for Node built-ins that have no meaning in the browser.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      http: false,
      https: false,
      zlib: false,
    };
    return config;
  },
};

export default nextConfig;
