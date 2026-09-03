'use client';

import { useViewStore } from '@/lib/store';

/**
 * Shown when Google Photorealistic 3D Tiles fail to load.
 *
 * Sibling of IonNotice, with one deliberate difference: dismissal is store
 * state, not local useState. The failure already forced a mode change back to
 * Schematic, so it has to survive a remount -- otherwise the toast would
 * reappear the next time this component happened to mount and imply the tiles
 * had failed a second time.
 *
 * The scene is never left broken behind this: by the time it renders, the
 * store has already fallen back to Schematic, so what the user is looking at
 * is the working view. This explains why it changed, it does not report a
 * dead end.
 */
export default function PhotorealNotice() {
  const photorealError = useViewStore((s) => s.photorealError);
  const dismiss = useViewStore((s) => s.dismissPhotorealError);
  const setBuildingStyle = useViewStore((s) => s.setBuildingStyle);

  if (!photorealError) return null;

  return (
    <div
      role="status"
      className="glass pointer-events-auto max-w-[330px] rounded-lg border-edgeStrong px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <span className="mt-[3px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
        <div>
          <div className="text-[11px] font-semibold text-ink">
            Photoreal unavailable — showing Schematic
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-[rgb(var(--muted))]">
            {photorealError}
          </p>
          <button
            type="button"
            onClick={() => setBuildingStyle('photoreal')}
            className="mt-1.5 rounded bg-[rgb(var(--tint)/0.06)] px-2 py-0.5 text-[10px] text-[rgb(var(--ink))] tint-hover"
          >
            Retry
          </button>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto rounded px-1 text-[13px] leading-none text-[rgb(var(--muted))] hover:text-[rgb(var(--ink))]"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
