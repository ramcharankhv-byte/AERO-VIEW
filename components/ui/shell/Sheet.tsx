'use client';

import { useEffect, useRef } from 'react';
import { SHEET_HEIGHT, useUiStore, type SheetSnap, type SheetTab } from '@/lib/ui-store';

/**
 * The compact-regime bottom sheet.
 *
 * Everything that is a floating panel on desktop lives in here on a phone,
 * behind a tab bar that is visible at every snap position. That last part is
 * the whole design: a collapsed panel the user cannot find again is worse than
 * one that never existed, so the sheet never closes -- it only lowers to a
 * peek, and the tabs stay on screen.
 */

/**
 * Tab labels. Short words, never bare numbers.
 *
 * scripts/verify_ui.mjs locates floor-ladder rungs by matching ANY button whose
 * trimmed innerText is /^(G|[0-9]{1,2}|B[0-9])$/, preferring the one reading
 * exactly '2'. A numbered tab would silently hijack that selector and the floor
 * test would drive this component instead of the ladder.
 */
const TABS: { id: SheetTab; label: string }[] = [
  { id: 'detail', label: 'Detail' },
  { id: 'layers', label: 'Layers' },
  { id: 'key', label: 'Key' },
  { id: 'stats', label: 'Stats' },
];

const NEXT_SNAP: Record<SheetSnap, SheetSnap> = {
  peek: 'half',
  half: 'full',
  full: 'peek',
};

export default function Sheet({
  detail,
  layers,
  legend,
  stats,
}: {
  detail: React.ReactNode;
  layers: React.ReactNode;
  legend: React.ReactNode;
  stats: React.ReactNode;
}) {
  const snap = useUiStore((s) => s.sheetSnap);
  const tab = useUiStore((s) => s.sheetTab);
  const setSnap = useUiStore((s) => s.setSheetSnap);
  const setTab = useUiStore((s) => s.setSheetTab);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * Lift Cesium's credit container clear of the sheet.
   *
   * The attribution box is a LICENCE obligation to Esri, Maxar, CARTO and OSM
   * and may never end up underneath a panel. It is positioned by
   * .cesium-viewer-bottom in globals.css, which reads --credit-bottom; the
   * sheet is the only thing that knows how tall it currently is, so the sheet
   * is what writes it. Measured rather than computed from SHEET_HEIGHT because
   * two of the three snaps are in dvh, and dvh on a phone is not a constant.
   */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      const root = document.documentElement.style;
      // Published rather than hard-coded at each call site: the sheet's height
      // changes with the snap, and the nav dock, floor ladder and status line
      // all have to ride above it.
      root.setProperty('--sheet-height', `${h}px`);
      root.setProperty('--credit-bottom', `${h + 8}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--credit-bottom');
      document.documentElement.style.removeProperty('--sheet-height');
    };
  }, []);

  return (
    <div
      ref={rootRef}
      data-panel="sheet"
      className="glass pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col rounded-t-xl transition-[height] duration-200 ease-out"
      style={{
        height: SHEET_HEIGHT[snap],
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Grab handle. A button, not a decorative bar: tapping it is the
          discoverable way to raise the sheet, and it is the only control here
          a keyboard user can reach to do so. */}
      <button
        type="button"
        onClick={() => setSnap(NEXT_SNAP[snap])}
        aria-label={`Sheet position: ${snap}. Activate to change.`}
        className="flex h-5 w-full shrink-0 items-center justify-center"
      >
        <span className="h-1 w-9 rounded-full bg-[rgb(var(--edge-strong))]" />
      </button>

      <div
        role="tablist"
        aria-label="Panels"
        className="flex shrink-0 gap-1 border-b border-[rgb(var(--edge))] px-2 pb-1.5"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`sheet-panel-${t.id}`}
            onClick={() => {
              setTab(t.id);
              if (snap === 'peek') setSnap('half');
            }}
            className={[
              'min-h-[32px] flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
              tab === t.id ? 'is-active' : 'text-[rgb(var(--muted))] tint-hover',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/*
        touch-action: pan-y and overscroll-contain together are what stop a
        scroll gesture inside the sheet from chaining out to the page and then
        to the globe -- which on a phone reads as the map lurching while you
        are trying to read a value.

        Every tab body stays MOUNTED and is hidden with the `hidden` attribute
        rather than being unmounted. DetailPanel calls useEnsureDetail, and
        remounting it on every tab change would re-run that effect; the layer
        controls would lose nothing but would flicker. `hidden` also keeps the
        inactive text out of innerText, which is what the acceptance harness
        reads.
      */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
        style={{ touchAction: 'pan-y' }}
      >
        <div id="sheet-panel-detail" role="tabpanel" hidden={tab !== 'detail'}>
          {detail}
        </div>
        <div id="sheet-panel-layers" role="tabpanel" hidden={tab !== 'layers'}>
          {layers}
        </div>
        <div id="sheet-panel-key" role="tabpanel" hidden={tab !== 'key'}>
          {legend}
        </div>
        <div id="sheet-panel-stats" role="tabpanel" hidden={tab !== 'stats'}>
          {stats}
        </div>
      </div>
    </div>
  );
}
