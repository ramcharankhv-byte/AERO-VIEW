'use client';

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
  const canSlice = activeBuildingId !== null;

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
        disabled={!canSlice}
        aria-pressed={slice.enabled}
        onClick={() => setSlice({ enabled: !slice.enabled })}
        title={
          canSlice
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
