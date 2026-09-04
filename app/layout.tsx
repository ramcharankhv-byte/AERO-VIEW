import type { Metadata, Viewport } from 'next';
import './globals.css';

/**
 * Generic now, because the root layout wraps both the gallery and every
 * project's viewer. The per-project title is supplied by
 * app/p/[slug]/page.tsx's generateMetadata, which names the AOI it resolved.
 */
export const metadata: Metadata = {
  title: '3D ULPIN — Vertical Property Mapper',
  description:
    'Three-dimensional cadastral viewer: parcel, building, floor and unit '
    + 'volumes with underground utility conflicts, one project per area of '
    + 'interest.',
};

/**
 * The app is a full-bleed 3D canvas, so the mobile viewport needs saying
 * explicitly.
 *
 * `viewportFit: 'cover'` is what makes env(safe-area-inset-*) non-zero, which
 * the bottom sheet needs to clear a home indicator. `interactiveWidget:
 * 'resizes-content'` makes the soft keyboard shrink the layout instead of
 * covering it -- without it the building edit form is typed into blind on a
 * phone. `userScalable` is deliberately NOT disabled: pinch-zoom is blocked on
 * the canvas with touch-action, where it belongs, rather than being taken away
 * from the whole document.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: '#000000',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        {/*
          Open the connections the scene is about to need, before it needs them.

          Measured: with the cadastre now fetched in under a second, the
          critical path to the first building is the Cesium ion round trip --
          an asset lookup on api.cesium.com followed by terrain tiles from
          assets.ion.cesium.com -- and it varied between 1.8 s and 3.9 s across
          runs (docs/perf/findings.md). A meaningful part of that is DNS, TCP
          and TLS to origins the browser has never spoken to, and all of it is
          paid before the first byte.

          preconnect does exactly that handshake early, in parallel with the
          bundle still downloading, so the terrain request starts on a warm
          connection. It cannot make anything slower: the worst case is an idle
          socket the browser closes.

          Three origins, deliberately -- browsers de-prioritise long preconnect
          lists, and these are the only cross-origin hosts on the boot path:
          ion's API, ion's tile CDN, and the default basemap. crossOrigin is
          required on all three because Cesium fetches them with CORS; without
          it the browser opens a second, anonymous connection and the hint is
          wasted.
        */}
        <link rel="preconnect" href="https://api.cesium.com" crossOrigin="" />
        <link rel="preconnect" href="https://assets.ion.cesium.com" crossOrigin="" />
        <link rel="preconnect" href="https://services.arcgisonline.com" crossOrigin="" />

        {/* Served from public/cesium (copied on postinstall) rather than
            imported, so the bundler never has to process Cesium's CSS. */}
        <link rel="stylesheet" href="/cesium/Widgets/widgets.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
