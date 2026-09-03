'use client';

import { useEffect } from 'react';
import { useLayoutRegime } from '@/lib/use-layout';
import { useUiStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/store';

import ActionBar from '../ActionBar';
import ConflictBanner from '../ConflictBanner';
import DataErrorNotice from '../DataErrorNotice';
import DetailPanel from '../DetailPanel';
import FloorLadder from '../FloorLadder';
import IonNotice from '../IonNotice';
import LayerPanel from '../LayerPanel';
import Legend from '../Legend';
import NavDock from '../NavDock';
import ParcelInset from '../ParcelInset';
import PhotorealNotice from '../PhotorealNotice';
import StatsPanel from '../StatsPanel';
import StatusBar from '../StatusBar';
import TopBar from '../TopBar';

import Drawer from './Drawer';
import RightRail from './RightRail';
import Sheet from './Sheet';

/**
 * All of the chrome, in whichever arrangement the viewport can carry.
 *
 * THE ONE-MOUNT RULE
 * ------------------
 * Each of these panels is rendered EXACTLY ONCE, in exactly one of the three
 * branches below. Nothing is duplicated and hidden with a CSS breakpoint.
 * That is not a stylistic preference:
 *
 *   - scripts/verify_ui.mjs drives the app through `document.querySelector(...)`
 *     and `[...querySelectorAll(...)].find(...)`, both of which take the FIRST
 *     match in document order. A `display:none` duplicate appearing first would
 *     silently absorb the test's clicks and input events while the visible
 *     control never moved -- a green test over a dead app.
 *   - DetailPanel calls useEnsureDetail; a second copy would double the effect
 *     work for no benefit.
 *   - Compact layout does not HIDE the panels, it RE-PARENTS them into the
 *     sheet, which no CSS class can express.
 *
 * The root stays `pointer-events-none` so drags pass through to the globe;
 * every panel re-enables pointer events on itself. Breaking that makes the map
 * undraggable, which is the single easiest thing to get wrong here.
 */
export default function OverlayRoot() {
  const regime = useLayoutRegime();

  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const sheetTab = useUiStore((s) => s.sheetTab);
  const revealDetail = useUiStore((s) => s.revealDetail);
  const setSheetTab = useUiStore((s) => s.setSheetTab);
  const setSheetSnap = useUiStore((s) => s.setSheetSnap);
  const sheetSnap = useUiStore((s) => s.sheetSnap);

  const statsOpen = useViewStore((s) => s.statsOpen);
  const setStatsOpen = useViewStore((s) => s.setStatsOpen);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);

  // A selection made on the canvas has to become visible without the user
  // having to go looking for it: on a phone the detail is behind a tab, so
  // picking a building raises the sheet onto it.
  useEffect(() => {
    if (regime === 'compact' && activeBuildingId !== null) revealDetail();
  }, [regime, activeBuildingId, revealDetail]);

  // In the sheet, "Stats" is a tab rather than a toggle, so the store flag has
  // to follow the tab or the panel would render nothing when selected.
  useEffect(() => {
    if (regime !== 'compact') return;
    setStatsOpen(sheetTab === 'stats');
  }, [regime, sheetTab, setStatsOpen]);

  // The drawer only exists at medium width; leaving it "open" behind a regime
  // change would strand the flag and hide the reopen affordance.
  useEffect(() => {
    if (regime !== 'medium') setDrawerOpen(false);
  }, [regime, setDrawerOpen]);

  // ------------------------------------------------------------- compact --
  if (regime === 'compact') {
    return (
      <div className="pointer-events-none absolute inset-0 z-20">
        <div className="absolute left-2 right-2 top-2">
          <TopBar
            compact
            onStatsClick={() => {
              setSheetTab('stats');
              if (sheetSnap === 'peek') setSheetSnap('half');
            }}
            statsActive={sheetTab === 'stats'}
          />
        </div>

        <div className="absolute left-1/2 top-[60px] w-[calc(100%-16px)] -translate-x-1/2">
          <ConflictBanner />
        </div>

        {/* Everything here rides on --sheet-height, which the Sheet measures and
            publishes, so raising the sheet lifts the dock and the status line
            with it instead of letting the sheet slide over them. */}
        <div
          className="absolute left-2 right-2 flex flex-col items-stretch gap-2"
          style={{ bottom: 'calc(var(--sheet-height, 140px) + 8px)' }}
        >
          <div className="flex flex-col items-end gap-2">
            <PhotorealNotice />
            <IonNotice />
          </div>
          <FloorLadder orientation="horizontal" />
          <NavDock compact />
          {/* Never dropped, however narrow it gets: the building count and the
              place name are what say which dataset is on screen, and the count
              is also how the acceptance harness knows the scene is live. */}
          <StatusBar dense />
        </div>

        <Sheet
          detail={
            <div className="flex flex-col gap-2">
              <ActionBar />
              <DetailPanel />
              <ParcelInset />
            </div>
          }
          layers={<LayerPanel />}
          legend={<Legend />}
          stats={<StatsPanel />}
        />
      </div>
    );
  }

  // -------------------------------------------------------------- medium --
  if (regime === 'medium') {
    return (
      <div className="pointer-events-none absolute inset-0 z-20">
        <div className="absolute left-3 right-3 top-3">
          <TopBar
            onLayersClick={() => setDrawerOpen(!drawerOpen)}
            layersOpen={drawerOpen}
          />
        </div>

        <div className="absolute bottom-[46px] left-3 top-[68px]">
          <Drawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            id="layer-drawer"
            title="Layers and display"
          >
            <div className="flex flex-col gap-2">
              <LayerPanel />
              <Legend />
            </div>
          </Drawer>
        </div>

        {/* Follows the drawer: with the panel closed the 228px offset it was
            clearing is dead space. */}
        <div
          className={[
            'absolute top-1/2 -translate-y-1/2 transition-[left] duration-200',
            drawerOpen ? 'left-[246px]' : 'left-3',
          ].join(' ')}
        >
          <FloorLadder />
        </div>

        <div className="absolute bottom-[46px] right-3 top-[68px] w-[288px]">
          {/* StatsPanel folds INTO the rail here. Beside it there is no room:
              268px of panel plus a 288px rail would reach across a 768px
              viewport and land on the drawer. */}
          <RightRail withStats={statsOpen} />
        </div>

        <div className="absolute left-3 right-[300px] top-[68px] flex justify-center">
          <ConflictBanner />
        </div>

        <div className="absolute bottom-[46px] left-1/2 -translate-x-1/2">
          <NavDock />
        </div>

        <div className="absolute bottom-3 left-3 right-3">
          <StatusBar dense />
        </div>

        <div className="absolute bottom-[46px] right-[300px] flex flex-col items-end gap-2">
          <DataErrorNotice />
          <PhotorealNotice />
          <IonNotice />
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- full --
  // Deliberately identical to the layout that shipped, down to the offsets:
  // this is the arrangement every reference screenshot and every acceptance
  // check was written against.
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="absolute left-3 right-3 top-3">
        <TopBar />
      </div>

      <div className="absolute bottom-[46px] left-3 top-[68px] flex w-[210px] flex-col gap-2 overflow-y-auto">
        <LayerPanel />
        <Legend />
      </div>

      <div className="absolute left-[228px] top-1/2 -translate-y-1/2">
        <FloorLadder />
      </div>

      <div className="absolute bottom-[46px] right-3 top-[68px] w-[318px]">
        <RightRail />
      </div>

      {/* Beside the right-hand column, not inside it. */}
      <div className="absolute right-[330px] top-[68px] max-h-[calc(100%-120px)] w-[268px]">
        <StatsPanel />
      </div>

      <div className="absolute left-1/2 top-[68px] flex -translate-x-1/2 justify-center">
        <ConflictBanner />
      </div>

      <div className="absolute bottom-[46px] left-1/2 -translate-x-1/2">
        <NavDock />
      </div>

      <div className="absolute bottom-3 left-3 right-3">
        <StatusBar />
      </div>

      {/* Both notices share the corner; stacked so a photoreal failure and a
          missing ion token can be reported at once rather than overlapping. */}
      <div className="absolute bottom-[46px] right-3 flex flex-col items-end gap-2">
        <DataErrorNotice />
        <PhotorealNotice />
        <IonNotice />
      </div>
    </div>
  );
}
