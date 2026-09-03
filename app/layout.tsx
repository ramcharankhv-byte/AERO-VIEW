import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '3D ULPIN — Vertical Property Mapper',
  description:
    'Three-dimensional cadastral viewer for Siripuram, Visakhapatnam: parcel, '
    + 'building, floor and unit volumes with underground utility conflicts.',
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
        {/* Served from public/cesium (copied on postinstall) rather than
            imported, so the bundler never has to process Cesium's CSS. */}
        <link rel="stylesheet" href="/cesium/Widgets/widgets.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
