'use client';

import { useSyncExternalStore } from 'react';

/**
 * Which chrome layout the viewport can carry.
 *
 * WHY THIS IS JAVASCRIPT AND NOT A CSS BREAKPOINT
 * -----------------------------------------------
 * The obvious Tailwind answer -- render both trees and hide one with
 * `hidden lg:block` -- is wrong here for two independent reasons:
 *
 *   1. It would mount every control twice. `scripts/verify_ui.mjs` drives the
 *      app through `document.querySelector('input[type=range][aria-label=
 *      "Explode"]')` and friends, which returns the FIRST match in document
 *      order. A display:none duplicate that happened to come first would
 *      absorb the test's input event, the scene would never move, and the
 *      check would still report PASS. A silent false pass is worse than a
 *      failure.
 *
 *   2. Compact layout does not hide the panels, it RE-PARENTS them -- the
 *      DetailPanel moves out of the right rail and into a bottom sheet's tab
 *      body. Re-parenting is not something a CSS class can express.
 *
 * So the regime is chosen once, in JS, and exactly one instance of every
 * control exists at any time. CSS breakpoints are still used freely for
 * cosmetics *within* a component (widths, gaps, type steps).
 *
 * Thresholds come from where this specific layout actually breaks, not from a
 * device catalogue:
 *   - 210px left panel + 318px right rail + margins collide under ~560px
 *   - StatsPanel (268px, offset right-[330px]) overlaps the left panel <~830px
 *   - the StatusBar's ten unwrapped children overflow under ~1100px
 */
export type LayoutRegime = 'compact' | 'medium' | 'full';

/** Full desktop rail layout. Below this the StatusBar starts to overflow. */
const FULL_MIN_PX = 1180;
/** Below this there is no room for a side panel and a rail at once. */
const MEDIUM_MIN_PX = 768;

function regimeFor(width: number): LayoutRegime {
  if (width >= FULL_MIN_PX) return 'full';
  if (width >= MEDIUM_MIN_PX) return 'medium';
  return 'compact';
}

/**
 * Subscribe to a media query list.
 *
 * useSyncExternalStore rather than useEffect + addEventListener because
 * next.config.mjs sets `reactStrictMode: false` (a documented Cesium
 * double-mount workaround), so there is no StrictMode double-invoke to shake
 * out a leaked listener in development. This shape subscribes and unsubscribes
 * correctly by construction.
 */
function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const mqs = [
    window.matchMedia(`(min-width: ${FULL_MIN_PX}px)`),
    window.matchMedia(`(min-width: ${MEDIUM_MIN_PX}px)`),
    window.matchMedia('(pointer: coarse)'),
  ];
  for (const mq of mqs) mq.addEventListener('change', onChange);
  // Height matters independently of width -- a short window overflows the
  // layer panel long before it narrows -- and a resize is the only event that
  // reports it.
  window.addEventListener('resize', onChange);
  return () => {
    for (const mq of mqs) mq.removeEventListener('change', onChange);
    window.removeEventListener('resize', onChange);
  };
}

/**
 * The current regime.
 *
 * getServerSnapshot returns 'full' and the client's first snapshot must agree
 * for a desktop viewport, or React 19 logs a hydration mismatch to the
 * console -- which fails verify_ui.mjs's "no runtime errors" check. The chrome
 * is prerendered (only `Scene` is ssr:false), so this genuinely runs on the
 * server.
 */
export function useLayoutRegime(): LayoutRegime {
  return useSyncExternalStore(
    subscribe,
    () => regimeFor(window.innerWidth),
    () => 'full' as LayoutRegime,
  );
}

/**
 * True on a touch-first device.
 *
 * Kept apart from the width regime on purpose: a 1024px tablet is coarse and a
 * 1024px desktop window is not, and hit-target sizing has to follow the
 * pointer rather than the viewport. It is also what gates hover-only affordances
 * such as the building tooltip, which cost a throttled scene.pick per pointer
 * move and mean nothing without a hover state.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia('(pointer: coarse)').matches,
    () => false,
  );
}

/**
 * Viewport height in CSS pixels, for the few decisions that depend on it.
 *
 * The LayerPanel is nine stacked sections tall and overflows below roughly
 * 900px of viewport height regardless of how wide the window is.
 */
export function useShortViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.innerHeight < 760,
    () => false,
  );
}
