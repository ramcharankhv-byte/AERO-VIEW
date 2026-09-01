'use client';

import { useEnsureDetail, useViewStore } from '@/lib/store';
import { levelLabel } from '@/lib/ulpin';

/**
 * Vertical floor ladder: R, 6, 5 ... G, B1, B2.
 *
 * A UI control, so it is allowed to write to the store -- it calls
 * isolateFloor() and nothing else. It does not touch the camera; CameraDirector
 * reacts to the store change and drops the view to the chosen level.
 */
export default function FloorLadder() {
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const isolateFloor = useViewStore((s) => s.isolateFloor);
  const detail = useEnsureDetail(mode === 'city' ? null : activeBuildingId);

  if (mode === 'city' || !detail || detail.floors.length === 0) return null;

  // Top of the building first, basements last -- the way a lift panel reads.
  const floors = [...detail.floors].sort((a, b) => b.level_no - a.level_no);
  const top = floors[0]?.level_no ?? 0;

  return (
    <div className="glass pointer-events-auto rounded-lg p-1.5">
      <div className="px-1 pb-1 text-center text-[9px] uppercase tracking-widest text-[rgb(var(--muted))]">
        Level
      </div>
      <div className="flex max-h-[46vh] flex-col gap-[3px] overflow-y-auto pr-0.5">
        {floors.map((f) => {
          const active = isolatedFloor === f.level_no;
          const basement = f.level_no < 0;
          return (
            <button
              key={f.id}
              type="button"
              title={`${f.ulpin} · ${f.z_min.toFixed(1)}–${f.z_max.toFixed(1)} m`}
              onClick={() => isolateFloor(active ? null : f.level_no)}
              className={[
                'h-6 w-9 rounded text-[11px] font-medium transition-colors',
                active
                  ? 'bg-[rgb(var(--accent))] text-black'
                  : basement
                    ? 'bg-white/5 text-[rgb(var(--muted))] hover:bg-white/15'
                    : 'bg-white/5 text-[rgb(var(--ink))] hover:bg-white/15',
              ].join(' ')}
            >
              {levelLabel(f.level_no, top)}
            </button>
          );
        })}
      </div>
      {isolatedFloor !== null ? (
        <button
          type="button"
          onClick={() => isolateFloor(null)}
          className="mt-1 w-9 rounded bg-white/5 py-0.5 text-[9px] text-[rgb(var(--muted))] hover:bg-white/15"
        >
          all
        </button>
      ) : null}
    </div>
  );
}
