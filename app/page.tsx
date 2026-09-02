'use client';

import dynamic from 'next/dynamic';
import { useViewStore } from '@/lib/store';
import ActionBar from '@/components/ui/ActionBar';
import ConflictBanner from '@/components/ui/ConflictBanner';
import DetailPanel from '@/components/ui/DetailPanel';
import FloorLadder from '@/components/ui/FloorLadder';
import IonNotice from '@/components/ui/IonNotice';
import LayerPanel from '@/components/ui/LayerPanel';
import Legend from '@/components/ui/Legend';
import NavDock from '@/components/ui/NavDock';
import ParcelInset from '@/components/ui/ParcelInset';
import PhotorealNotice from '@/components/ui/PhotorealNotice';
import StatusBar from '@/components/ui/StatusBar';
import TopBar from '@/components/ui/TopBar';

/**
 * Composes the scene and the chrome. No logic lives here beyond the panel
 * visibility flag from the store.
 *
 * The whole Cesium tree is client-only: Cesium touches `window` at module
 * evaluation time, so server rendering it is not merely wasteful, it throws.
 *
 * Responsive: breakpoints collapse the chrome rather than letting it overlap.
 * Below `lg` the right column narrows and the parcel inset drops; below `md`
 * the layer panel is toggled from the TopBar, the floor ladder moves up clear
 * of the NavDock, and the secondary status items hide.
 */
const Scene = dynamic(() => import('@/components/globe/Scene'), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center bg-[#05080f]">
      <span className="text-sm text-slate-400">Initialising globe…</span>
    </div>
  ),
});

export default function Page() {
  const leftPanelOpen = useViewStore((s) => s.leftPanelOpen);

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <Scene />

      {/* Chrome floats over a full-bleed canvas; the wrapper must not eat
          pointer events meant for the globe. */}
      <div className="pointer-events-none absolute inset-0 z-20">
        <div className="absolute left-3 right-3 top-3">
          <TopBar />
        </div>

        {/* Layer panel: store-toggled so small screens can reclaim the left
            edge; hidden entirely below md, where the map wants every pixel. */}
        {leftPanelOpen ? (
          <div className="absolute left-3 top-[68px] hidden md:block">
            <LayerPanel />
          </div>
        ) : null}

        {/* Floor ladder: vertically centred at md+, but raised above the dock
            on small screens so the two never overlap. */}
        <div className="absolute left-3 top-1/2 -translate-y-1/2 md:left-[228px]">
          <FloorLadder />
        </div>

        <div className="absolute bottom-[70px] left-3 hidden lg:block">
          <Legend />
        </div>

        <div className="absolute right-3 top-[68px] flex w-[318px] max-w-[calc(100vw-24px)] flex-col gap-2 lg:w-[318px] md:w-[280px] max-md:w-[calc(100vw-24px)]">
          <ActionBar />
          <div className="max-h-[calc(100vh-210px)] overflow-y-auto pr-0.5 max-md:max-h-[calc(100vh-320px)]">
            <DetailPanel />
          </div>
          <div className="hidden lg:block">
            <ParcelInset />
          </div>
        </div>

        <div className="absolute left-1/2 top-[68px] -translate-x-1/2 max-md:w-[calc(100vw-24px)] max-md:px-1">
          <ConflictBanner />
        </div>

        <div className="absolute left-1/2 bottom-[46px] -translate-x-1/2">
          <NavDock />
        </div>

        <div className="absolute left-3 right-3 bottom-3">
          <StatusBar />
        </div>

        {/* Both notices share the corner; stacked so a photoreal failure and a
            missing ion token can be reported at once rather than overlapping.
            Hidden on small screens, where the StatusBar's right cluster already
            reports fallback state. */}
        <div className="absolute right-3 bottom-[46px] hidden flex-col items-end gap-2 lg:flex">
          <PhotorealNotice />
          <IonNotice />
        </div>
      </div>
    </main>
  );
}
