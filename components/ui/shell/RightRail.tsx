'use client';

import ActionBar from '../ActionBar';
import DetailPanel from '../DetailPanel';
import ParcelInset from '../ParcelInset';
import StatsPanel from '../StatsPanel';

/**
 * The right-hand column: actions on top, the scrolling detail body, context
 * beneath.
 *
 * This replaces a `max-h-[calc(100vh-210px)]` magic number with a real flex
 * column. The old form had two problems the edit form and the road detail mode
 * would both have made worse: the cap was wrong at any viewport height other
 * than the one it was tuned at, and anything added to the rail required
 * recomputing the 210. Here the body simply takes the space the other two
 * children leave, at any height.
 *
 * `min-h-0` on the scrolling child is load-bearing. A flex item's default
 * `min-height: auto` refuses to shrink below its content, so without it the
 * body grows to its natural height and pushes ParcelInset off the bottom of
 * the screen instead of scrolling.
 */
export default function RightRail({
  /** Medium regime folds StatsPanel into the rail; at full width it sits beside it. */
  withStats = false,
}: {
  withStats?: boolean;
}) {
  return (
    <div className="pointer-events-none flex h-full flex-col gap-2">
      <ActionBar />
      {withStats ? <StatsPanel /> : null}
      <div
        data-panel="rail-body"
        className="pointer-events-auto min-h-0 flex-1 overflow-y-auto pr-0.5"
      >
        <DetailPanel />
      </div>
      <ParcelInset />
    </div>
  );
}
