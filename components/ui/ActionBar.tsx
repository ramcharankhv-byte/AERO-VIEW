'use client';

import { useViewStore } from '@/lib/store';

/**
 * Mode actions above the detail panel: step back out of the current level,
 * toggle underground, and the disabled Measurements/Share/Split/Slice group.
 */
export default function ActionBar() {
  const mode = useViewStore((s) => s.mode);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const selectedUnitId = useViewStore((s) => s.selectedUnitId);
  const underground = useViewStore((s) => s.underground);
  const setUnderground = useViewStore((s) => s.setUnderground);
  const selectUnit = useViewStore((s) => s.selectUnit);
  const isolateFloor = useViewStore((s) => s.isolateFloor);
  const selectBuilding = useViewStore((s) => s.selectBuilding);

  const back = () => {
    if (selectedUnitId !== null) return selectUnit(null);
    if (isolatedFloor !== null) return isolateFloor(null);
    return selectBuilding(null);
  };

  const backLabel =
    selectedUnitId !== null
      ? 'Back to floor'
      : isolatedFloor !== null
        ? 'Back to building'
        : 'Back to city';

  return (
    <div className="glass pointer-events-auto flex items-center gap-1 rounded-lg px-1.5 py-1">
      {mode !== 'city' ? (
        <button
          type="button"
          onClick={back}
          className="rounded px-2 py-1 text-[11px] text-[rgb(var(--ink))] hover:bg-white/10"
        >
          {backLabel}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setUnderground(!underground)}
        className={[
          'rounded px-2 py-1 text-[11px] transition-colors',
          underground
            ? 'bg-[rgb(var(--accent))] text-black'
            : 'text-[rgb(var(--ink))] hover:bg-white/10',
        ].join(' ')}
      >
        Underground
      </button>
      <span className="mx-0.5 h-4 w-px bg-[rgb(var(--edge))]" />
      {['Measure', 'Share', 'Split', 'Slice'].map((label) => (
        <button
          key={label}
          type="button"
          disabled
          title={label + ' — not implemented'}
          className="is-disabled rounded px-2 py-1 text-[11px] text-[rgb(var(--muted))]"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
