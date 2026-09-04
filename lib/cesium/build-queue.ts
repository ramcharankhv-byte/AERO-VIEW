'use client';

/**
 * Time-sliced entity construction.
 *
 * WHY. Every layer used to build its whole data source inside one effect body.
 * At the dataset this app actually serves -- 2,597 buildings, 1,634 parcels,
 * 1,515 utility runs, 12,101 entities in total -- that is a single 3.7-second
 * task on the main thread (measured: docs/perf/before.json, `worstLongTaskMs`).
 * The browser cannot paint, cannot scroll and cannot respond to a click for the
 * whole of it. That one task IS the "device hangs while the map initialises"
 * symptom; nothing else in the profile comes close.
 *
 * The work itself is not wasted -- those entities are wanted. What is wrong is
 * doing it all between two paints. So it is cut into slices with a frame budget
 * and spread across frames: the first slice puts geometry on screen almost
 * immediately and the rest arrives progressively, which is also a better answer
 * visually than a frozen tab followed by everything at once.
 *
 * DESIGN NOTES
 *
 *   - `scheduler.postTask` at 'background' priority is used when the browser
 *     has it, because it yields to input and rendering properly. The fallback
 *     is a MessageChannel macrotask, NOT setTimeout: a nested setTimeout(0) is
 *     clamped to 4 ms after five levels, which would triple the wall time.
 *   - The budget is per slice, checked between items, so one pathological item
 *     can overrun -- it cannot be pre-empted mid-call. 6 ms leaves room inside
 *     a 16 ms frame for Cesium's own per-frame work.
 *   - Cancellation is the whole reason this returns a disposer. A layer effect
 *     that re-runs (new data, a rebuild) must be able to abandon the previous
 *     pass immediately, or two passes write into two data sources and the
 *     scene shows both.
 */

/** Per-slice main-thread budget, milliseconds. */
const SLICE_BUDGET_MS = 6;

type PostTask = (cb: () => void, opts: { priority: string }) => Promise<void>;

interface SchedulerLike {
  postTask?: PostTask;
}

/** Yield to the browser, preferring a real scheduler when one exists. */
function yieldToBrowser(run: () => void): () => void {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (scheduler && typeof scheduler.postTask === 'function') {
    let cancelled = false;
    scheduler.postTask(() => { if (!cancelled) run(); }, { priority: 'background' })
      // A postTask promise rejects on abort; there is no abort here, but an
      // unhandled rejection would still be reported.
      .catch(() => {});
    return () => { cancelled = true; };
  }
  // MessageChannel: an unclamped macrotask that still lets the browser paint
  // and handle input between slices.
  const channel = new MessageChannel();
  let cancelled = false;
  channel.port1.onmessage = () => {
    channel.port1.onmessage = null;
    if (!cancelled) run();
  };
  channel.port2.postMessage(null);
  return () => {
    cancelled = true;
    channel.port1.onmessage = null;
  };
}

export interface IncrementalBuildOptions<T> {
  /** The items to process, in the order they should appear. */
  items: readonly T[];
  /** Build one item. Must be safe to call after `onSlice`, before `onDone`. */
  step: (item: T, index: number) => void;
  /**
   * Called after each slice with how many items are done. Layers use it to ask
   * Cesium for a frame, so progress is visible rather than merely happening.
   */
  onSlice?: (completed: number, total: number) => void;
  /** Called once, after the last item. Never called if the build is cancelled. */
  onDone?: () => void;
  /**
   * How many items to build synchronously before the first yield.
   *
   * The first slice is what the user sees first, so it is worth spending a
   * little more of the current task on it than on the slices after it. Zero
   * means "use the normal budget".
   */
  firstSlice?: number;
  /** Override the per-slice budget. Only for tests and tuning. */
  budgetMs?: number;
}

/**
 * Build `items` across frames. Returns a disposer that abandons the build.
 *
 * The disposer does NOT undo work already done -- callers own the data source
 * the steps wrote into and remove that instead, which is both cheaper and the
 * only correct order (removing the data source first would leave later slices
 * writing into a detached collection).
 */
export function buildIncrementally<T>(opts: IncrementalBuildOptions<T>): () => void {
  const { items, step, onSlice, onDone } = opts;
  const budget = opts.budgetMs ?? SLICE_BUDGET_MS;
  let index = 0;
  let cancelled = false;
  let cancelPending: (() => void) | null = null;

  const runSlice = (limit: number) => {
    if (cancelled) return;
    const started = performance.now();
    let inSlice = 0;
    while (index < items.length) {
      step(items[index], index);
      index++;
      inSlice++;
      if (limit > 0 ? inSlice >= limit : performance.now() - started >= budget) break;
    }
    onSlice?.(index, items.length);
    if (index >= items.length) {
      onDone?.();
      return;
    }
    cancelPending = yieldToBrowser(() => runSlice(0));
  };

  // The first slice runs synchronously, inside the caller's task: a layer that
  // yields before drawing anything shows an empty scene for a frame longer than
  // it needs to.
  runSlice(opts.firstSlice ?? 0);

  return () => {
    cancelled = true;
    cancelPending?.();
    cancelPending = null;
  };
}
