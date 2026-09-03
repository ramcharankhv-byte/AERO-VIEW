'use client';

import { useEffect, useRef } from 'react';
import { useViewer } from './CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { ProvenanceBadge } from '../ui/Provenance';
import { useCoarsePointer } from '@/lib/use-layout';

/**
 * The hover tooltip for city view.
 *
 * Ownership is split deliberately. The Picker owns WHAT is hovered -- it runs
 * the app's single ScreenSpaceEventHandler and writes hoveredBuildingId -- and
 * this component owns only WHERE the cursor is. That keeps the picking cost at
 * one throttled pick per move, adds no second Cesium handler, and needs no
 * store field for the pointer position.
 *
 * There is no fetch here: every field shown is already in the buildings
 * FeatureCollection loaded at boot.
 */

/** Cursor offset, and the margin at which the card flips to the other side. */
const OFFSET_PX = 14;
const FLIP_MARGIN_PX = 220;

export default function BuildingTooltip() {
  const { viewer, ready } = useViewer();
  const hoveredBuildingId = useViewStore((s) => s.hoveredBuildingId);
  const mode = useViewStore((s) => s.mode);
  const underground = useViewStore((s) => s.underground);
  const buildings = useDataStore((s) => s.buildings);

  const boxRef = useRef<HTMLDivElement | null>(null);

  // The tooltip is only meaningful over the city massing: in building, floor
  // and unit modes the DetailPanel is already showing this building, and
  // underground the surface is not the subject.
  // A hover card means nothing on a touch device -- there is no hover state to
  // report -- and rendering it would only cost a DOM overlay and a mousemove
  // listener that never usefully fires.
  const coarse = useCoarsePointer();
  const visible =
    !coarse && hoveredBuildingId !== null && mode === 'city' && !underground;

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed() || !visible) return;
    const canvas = viewer.scene.canvas;

    let x = 0;
    let y = 0;
    let raf = 0;

    // Position is written straight to the transform inside a rAF rather than
    // through React state: the pointer moves far more often than the tooltip's
    // contents change, and re-rendering on every sample would be wasted work.
    const paint = () => {
      raf = 0;
      const box = boxRef.current;
      if (!box) return;
      const flipX = x > window.innerWidth - FLIP_MARGIN_PX;
      const flipY = y > window.innerHeight - FLIP_MARGIN_PX;
      const left = flipX ? x - OFFSET_PX : x + OFFSET_PX;
      const top = flipY ? y - OFFSET_PX : y + OFFSET_PX;
      box.style.transform =
        `translate(${left}px, ${top}px) translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`;
    };

    const onMove = (e: MouseEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (raf === 0) raf = requestAnimationFrame(paint);
    };

    canvas.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [viewer, ready, visible]);

  if (!visible) return null;
  const props = buildings?.features.find(
    (f) => f.properties.id === hoveredBuildingId,
  )?.properties;
  if (!props) return null;

  return (
    <div
      ref={boxRef}
      className="glass pointer-events-none fixed left-0 top-0 z-30 w-[190px] rounded-md p-2"
    >
      <div className="truncate text-[12px] font-semibold capitalize text-[rgb(var(--ink))]">
        {props.name ?? `${props.use_type} building`}
      </div>
      {/* Right-truncated: the tail of a ULPIN is the part that identifies the
          individual building, so an ellipsis belongs at the front. */}
      <div
        className="truncate text-left font-mono text-[10px] text-[rgb(var(--muted))]"
        style={{ direction: 'rtl' }}
        title={props.ulpin}
      >
        {props.ulpin}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-[11px] text-[rgb(var(--ink))]">
          {props.floors} storeys ·
        </span>
        <ProvenanceBadge
          source={props.height_source}
          synthetic={props.survey_synthetic}
        />
      </div>
    </div>
  );
}
