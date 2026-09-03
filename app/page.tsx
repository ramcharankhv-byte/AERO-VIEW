'use client';

import dynamic from 'next/dynamic';
import OverlayRoot from '@/components/ui/shell/OverlayRoot';

/**
 * Composes the scene and the chrome. No logic lives here.
 *
 * The whole Cesium tree is client-only: Cesium touches `window` at module
 * evaluation time, so server rendering it is not merely wasteful, it throws.
 *
 * The chrome's arrangement moved into OverlayRoot, which picks one of three
 * layouts for the viewport. It is deliberately NOT inlined here any more: the
 * choice is made in JavaScript so that exactly one instance of every control
 * exists at a time -- see the note at the top of that file for why duplicating
 * the tree behind CSS breakpoints would silently break the acceptance harness.
 */
const Scene = dynamic(() => import('@/components/globe/Scene'), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center bg-bg">
      <span className="text-sm text-muted">Initialising globe…</span>
    </div>
  ),
});

export default function Page() {
  return (
    // h-dvh, not h-screen: on a phone `100vh` is the height the viewport would
    // have with the browser chrome retracted, so the status bar sits under the
    // address bar until the user scrolls -- which they cannot, because the page
    // does not scroll.
    <main className="relative h-dvh w-screen overflow-hidden">
      <Scene />
      <OverlayRoot />
    </main>
  );
}
