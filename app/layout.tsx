import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '3D ULPIN — Vertical Property Mapper',
  description:
    'Three-dimensional cadastral viewer for Siripuram, Visakhapatnam: parcel, '
    + 'building, floor and unit volumes with underground utility conflicts.',
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
