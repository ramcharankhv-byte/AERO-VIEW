'use client';

import { useEffect } from 'react';
import { useViewStore } from '@/lib/store';

/**
 * Bottom-centre navigation dock.
 *
 * Orbit / Pan / Zoom set which gestures the camera controller accepts (applied
 * in CesiumRoot). Reset and Auto-spin write store state that CameraDirector
 * acts on. Nothing here calls a camera method directly.
 *
 * Slice toggles the section cut through the active building. It needs one to
 * cut, so it is disabled in city view; the axis and the plane position live in
 * the LayerPanel next to the Explode slider the two are exclusive with.
 *
 * 2D GIS sits immediately left of Slice, and turning it on disables both Slice
 * and Explode -- which the store enforces, so those two controls only have to
 * RENDER the exclusion, not implement it.
 *
 * THE KEYBOARD SHORTCUT LIVES HERE, and it is the first one in this
 * application: components/ui/shell/Drawer.tsx's Escape handler is the only
 * other window-level key listener, and it is scoped to a drawer that is open.
 * There was therefore no convention to follow and none is invented beyond this
 * one letter. It is registered next to the button it duplicates rather than in
 * a shortcut registry, because a registry with one entry is a place for the
 * shortcut and the control to drift apart.
 */
export default function NavDock({
  /** Phone layout: tighter padding and a 44px minimum tap target. */
  compact = false,
}: { compact?: boolean } = {}) {
  const navMode = useViewStore((s) => s.navMode);
  const setNavMode = useViewStore((s) => s.setNavMode);
  const autoSpin = useViewStore((s) => s.autoSpin);
  const setAutoSpin = useViewStore((s) => s.setAutoSpin);
  const resetView = useViewStore((s) => s.resetView);
  const slice = useViewStore((s) => s.slice);
  const setSlice = useViewStore((s) => s.setSlice);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const gis2d = useViewStore((s) => s.gis2d);
  const setGis2d = useViewStore((s) => s.setGis2d);
  // Disabled while the 2D view is on, as well as with nothing selected. Both
  // are states in which a section cut through the active building means
  // nothing; the store already refuses the combination, and this is the
  // control saying so before the user tries.
  const canSlice = activeBuildingId !== null && !gis2d;

  /**
   * G toggles the 2D view.
   *
   * Ignored while the user is typing -- the TopBar carries a ULPIN search
   * field, and a bare letter shortcut that fires inside a text input is a
   * search box that silently rearranges the scene between keystrokes. Also
   * ignored with any modifier held, so it never shadows a browser or operating
   * system binding (Ctrl+G is find-next).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'g' && e.key !== 'G') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (el?.isContentEditable) return;
      e.preventDefault();
      setGis2d(!useViewStore.getState().gis2d);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setGis2d]);

  return (
    <div
      data-panel="nav"
      className={[
        'glass pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg px-1.5 py-1',
        compact ? '[&_button]:min-h-[36px]' : '',
      ].join(' ')}
    >
      {(['orbit', 'pan', 'zoom'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setNavMode(m)}
          className={[
            'rounded px-2.5 py-1 text-[11px] capitalize transition-colors',
            navMode === m
              ? 'is-active'
              : 'text-[rgb(var(--ink))] tint-hover',
          ].join(' ')}
        >
          {m}
        </button>
      ))}

      <span className="mx-1 h-4 w-px bg-[rgb(var(--edge))]" />

      <button
        type="button"
        onClick={resetView}
        className="rounded px-2.5 py-1 text-[11px] text-[rgb(var(--ink))] tint-hover"
      >
        Reset view
      </button>
      <button
        type="button"
        onClick={() => setAutoSpin(!autoSpin)}
        className={[
          'rounded px-2.5 py-1 text-[11px] transition-colors',
          autoSpin
            ? 'is-active'
            : 'text-[rgb(var(--ink))] tint-hover',
        ].join(' ')}
      >
        Auto-spin
      </button>

      <span className="mx-1 h-4 w-px bg-[rgb(var(--edge))]" />

      <button
        type="button"
        aria-pressed={gis2d}
        onClick={() => setGis2d(!gis2d)}
        title="2D GIS — top-down cadastral map of derived parcels (G)"
        className={[
          'rounded px-2.5 py-1 text-[11px] transition-colors',
          gis2d ? 'is-active' : 'text-[rgb(var(--ink))] tint-hover',
        ].join(' ')}
      >
        2D GIS
      </button>

      <button
        type="button"
        disabled={!canSlice}
        aria-pressed={slice.enabled}
        onClick={() => setSlice({ enabled: !slice.enabled })}
        title={
          gis2d
            ? 'Slice — not available in the 2D GIS view'
            : canSlice
              ? 'Section cut through the active building'
              : 'Slice — select a building first'
        }
        className={[
          'rounded px-2.5 py-1 text-[11px] transition-colors',
          !canSlice
            ? 'is-disabled text-[rgb(var(--muted))]'
            : slice.enabled
              ? 'is-active'
              : 'text-[rgb(var(--ink))] tint-hover',
        ].join(' ')}
      >
        Slice
      </button>
    </div>
  );
}
