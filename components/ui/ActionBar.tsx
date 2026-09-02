'use client';

import { useState } from 'react';
import { useViewStore } from '@/lib/store';
import { copyViewLink } from '@/lib/url-state';

/**
 * Mode actions above the detail panel: step back out of the current level,
 * toggle underground, cut a section, and the tool group — Share copies the
 * shareable view URL (lib/url-state.ts already keeps the address bar in step
 * with the scene); Measure/Split are rendered visibly disabled rather than
 * hidden.
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
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const slice = useViewStore((s) => s.slice);
  const setSlice = useViewStore((s) => s.setSlice);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const back = () => {
    if (selectedUnitId !== null) return selectUnit(null);
    if (isolatedFloor !== null) return isolateFloor(null);
    return selectBuilding(null);
  };

  const share = async () => {
    const ok = await copyViewLink();
    setShareNote(ok ? 'Copied ✓' : 'Copy failed');
    setTimeout(() => setShareNote(null), 1400);
  };

  const backLabel =
    selectedUnitId !== null
      ? 'Back to floor'
      : isolatedFloor !== null
        ? 'Back to building'
        : 'Back to city';

  return (
    <div className="glass pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg px-1.5 py-1">
      {mode !== 'city' ? (
        <button
          type="button"
          onClick={back}
          className="rounded px-2 py-1 text-[11px] text-[rgb(var(--ink))] hover:bg-white/10"
        >
          ← {backLabel}
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
      <button
        type="button"
        disabled={activeBuildingId === null}
        aria-pressed={slice.enabled}
        onClick={() => setSlice({ enabled: !slice.enabled })}
        title={
          activeBuildingId === null
            ? 'Slice — select a building first'
            : 'Section cut through the active building'
        }
        className={[
          'rounded px-2 py-1 text-[11px] transition-colors',
          activeBuildingId === null
            ? 'is-disabled text-[rgb(var(--muted))]'
            : slice.enabled
              ? 'bg-[rgb(var(--accent))] text-black'
              : 'text-[rgb(var(--ink))] hover:bg-white/10',
        ].join(' ')}
      >
        Slice
      </button>
      <span className="mx-0.5 hidden h-4 w-px bg-[rgb(var(--edge))] sm:block" />
      <button
        type="button"
        onClick={share}
        title="Copy a link to this exact view"
        className={[
          'rounded px-2 py-1 text-[11px] transition-colors',
          shareNote
            ? 'bg-[rgb(var(--accent))] text-black'
            : 'text-[rgb(var(--ink))] hover:bg-white/10',
        ].join(' ')}
      >
        {shareNote ?? 'Share'}
      </button>
      {['Measure', 'Split'].map((label) => (
        <button
          key={label}
          type="button"
          disabled
          title={label + ' — not implemented'}
          className="is-disabled hidden rounded px-2 py-1 text-[11px] text-[rgb(var(--muted))] sm:block"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
