'use client';

import dynamic from 'next/dynamic';
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
import StatsPanel from '@/components/ui/StatsPanel';
import TopBar from '@/components/ui/TopBar';

/**
 * Composes the scene and the chrome. No logic lives here.
 *
 * The whole Cesium tree is client-only: Cesium touches `window` at module
 * evaluation time, so server rendering it is not merely wasteful, it throws.
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
  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <Scene />

      {/* Chrome floats over a full-bleed canvas; the wrapper must not eat
          pointer events meant for the globe. */}
      <div className="pointer-events-none absolute inset-0 z-20">
        <div className="absolute left-3 right-3 top-3">
          <TopBar />
        </div>

        <div className="absolute left-3 top-[68px]">
          <LayerPanel />
        </div>

        <div className="absolute left-[228px] top-1/2 -translate-y-1/2">
          <FloorLadder />
        </div>

        <div className="absolute left-3 bottom-[70px]">
          <Legend />
        </div>

        <div className="absolute right-3 top-[68px] flex w-[318px] flex-col gap-2">
          <ActionBar />
          <div className="max-h-[calc(100vh-210px)] overflow-y-auto pr-0.5">
            <DetailPanel />
          </div>
          <ParcelInset />
        </div>

        {/* Beside the right-hand column, not inside it: stacking it there
            would reflow the DetailPanel's scroll cap every time Stats opens. */}
        <div className="absolute right-[330px] top-[68px]">
          <StatsPanel />
        </div>

        <div className="absolute left-1/2 top-[68px] -translate-x-1/2">
          <ConflictBanner />
        </div>

        <div className="absolute left-1/2 bottom-[46px] -translate-x-1/2">
          <NavDock />
        </div>

        <div className="absolute left-3 right-3 bottom-3">
          <StatusBar />
        </div>

        {/* Both notices share the corner; stacked so a photoreal failure and a
            missing ion token can be reported at once rather than overlapping. */}
        <div className="absolute right-3 bottom-[46px] flex flex-col items-end gap-2">
          <PhotorealNotice />
          <IonNotice />
        </div>
      </div>
    </main>
  );
}
