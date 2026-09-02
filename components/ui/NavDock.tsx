'use client';

import { useViewStore } from '@/lib/store';

/**
 * Bottom-centre navigation dock.
 *
 * Orbit / Pan / Zoom set which gestures the camera controller accepts (applied
 * in CesiumRoot). Reset and Auto-spin write store state that CameraDirector
 * acts on. Nothing here calls a camera method directly.
 *
 * Slice is present but disabled, as specified.
 */
export default function NavDock() {
  const navMode = useViewStore((s) => s.navMode);
  const setNavMode = useViewStore((s) => s.setNavMode);
  const autoSpin = useViewStore((s) => s.autoSpin);
  const setAutoSpin = useViewStore((s) => s.setAutoSpin);
  const resetView = useViewStore((s) => s.resetView);

  return (
    <div className="glass pointer-events-auto flex items-center gap-1 rounded-lg px-1.5 py-1">
      {(['orbit', 'pan', 'zoom'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setNavMode(m)}
          className={[
            'rounded px-2.5 py-1 text-[11px] capitalize transition-colors',
            navMode === m
              ? 'bg-[rgb(var(--accent))] text-black'
              : 'text-[rgb(var(--ink))] hover:bg-white/10',
          ].join(' ')}
        >
          {m}
        </button>
      ))}

      <span className="mx-1 h-4 w-px bg-[rgb(var(--edge))]" />

      <button
        type="button"
        onClick={resetView}
        className="rounded px-2.5 py-1 text-[11px] text-[rgb(var(--ink))] hover:bg-white/10"
      >
        Reset
      </button>
      <button
        type="button"
        onClick={() => setAutoSpin(!autoSpin)}
        className={[
          'rounded px-2.5 py-1 text-[11px] transition-colors',
          autoSpin
            ? 'bg-[rgb(var(--accent))] text-black'
            : 'text-[rgb(var(--ink))] hover:bg-white/10',
        ].join(' ')}
      >
        Spin
      </button>

      <span className="mx-1 hidden h-4 w-px bg-[rgb(var(--edge))] sm:block" />

      <button
        type="button"
        disabled
        title="Slice — not implemented"
        className="is-disabled hidden rounded px-2.5 py-1 text-[11px] text-[rgb(var(--muted))] sm:block"
      >
        Slice
      </button>
    </div>
  );
}
