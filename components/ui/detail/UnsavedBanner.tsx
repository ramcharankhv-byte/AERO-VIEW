'use client';

import { useEditStore } from '@/lib/store';
import { useViewStore } from '@/lib/store';

/**
 * "You have unsaved changes to a different building."
 *
 * WHY THIS IS A BANNER AND NOT A CONFIRM DIALOG
 * --------------------------------------------
 * The conventional answer is to intercept the navigation and ask. That cannot
 * work here: selection happens on a Cesium canvas click, which has already
 * written the view store by the time React could render a dialog. Blocking it
 * afterwards would be a lie about what had happened, and the same problem
 * arises for selection by search and by URL.
 *
 * So the draft is KEPT rather than discarded, and the panel says where it is
 * and offers to go back to it. Nothing is lost, and the user is told the truth
 * about the state they are in.
 */
export default function UnsavedBanner({ activeId }: { activeId: number }) {
  const editingId = useEditStore((s) => s.editingId);
  const drafts = useEditStore((s) => s.drafts);
  const cancelEdit = useEditStore((s) => s.cancelEdit);
  const selectBuilding = useViewStore((s) => s.selectBuilding);

  // Only when there is a draft for a DIFFERENT building than the one on screen.
  const stranded = Object.entries(drafts)
    .map(([k, v]) => ({ id: Number(k), count: Object.keys(v ?? {}).length }))
    .filter((d) => d.count > 0 && d.id !== activeId && d.id !== editingId);

  if (stranded.length === 0) return null;
  const d = stranded[0];

  return (
    <div className="mt-2 rounded border border-[rgb(var(--edge-strong))] bg-[rgb(var(--surface-2))] p-2">
      <p className="text-[11px] text-[rgb(var(--ink))]">
        Unsaved changes to building{' '}
        <span className="font-mono">BLD-{1000 + d.id}</span>
        {' '}({d.count} field{d.count === 1 ? '' : 's'}).
      </p>
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          onClick={() => selectBuilding(d.id)}
          className="rounded border border-[rgb(var(--edge-strong))] px-2 py-0.5 text-[11px] text-[rgb(var(--ink))] tint-hover"
        >
          Return &amp; finish
        </button>
        <button
          type="button"
          onClick={() => cancelEdit(d.id)}
          className="rounded px-2 py-0.5 text-[11px] text-[rgb(var(--muted))] tint-hover"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
