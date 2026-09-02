'use client';

import { useDataStore, useViewStore } from '@/lib/store';
import { useViewer } from '../globe/CesiumRoot';
import { PROVIDER_LABELS } from '@/lib/cesium/imagery-catalog';
import { useCameraHeight } from '@/lib/cesium/setup';

/** Bottom bar: coordinate system, scale, accuracy and the real building count. */
export default function StatusBar() {
  const buildings = useDataStore((s) => s.buildings);
  const conflicts = useDataStore((s) => s.conflicts);
  const mode = useViewStore((s) => s.mode);
  const underground = useViewStore((s) => s.underground);
  const ionFallback = useViewStore((s) => s.ionFallback);
  const imageryProvider = useViewStore((s) => s.imageryProvider);
  const imageryActive = useViewStore((s) => s.imageryActive);
  const buildingStyle = useViewStore((s) => s.buildingStyle);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const detail = useDataStore((s) => s.detail);

  const { viewer } = useViewer();
  const camHeight = useCameraHeight(viewer);

  const count = buildings?.features.length ?? 0;
  const activeProps = activeBuildingId !== null
    ? buildings?.features.find((f) => f.properties.id === activeBuildingId)?.properties
    : null;
  const parcelUlpin = activeBuildingId !== null ? detail[activeBuildingId]?.parcel?.ulpin : null;

  return (
    <div className="glass pointer-events-auto flex h-7 items-center gap-3 overflow-hidden rounded-lg px-3 text-[10px] text-[rgb(var(--muted))]">
      <span className="shrink-0 font-medium text-[rgb(var(--ink))]">{count} 3D buildings</span>
      <Sep />
      <span className="hidden shrink-0 sm:inline">Siripuram, Visakhapatnam</span>
      <Sep />
      <span className="hidden shrink-0 lg:inline">WGS 84 / EPSG:4326 · Z in metres</span>
      <Sep />
      <span className="hidden shrink-0 md:inline">AOI 1.22 × 1.11 km</span>
      <Sep />
      {/* Stated honestly: heights are mostly inferred, not measured. */}
      <span
        className="hidden shrink-0 md:inline"
        title="90% of heights are inferred from footprint area and building tag"
      >
        Height accuracy ±1 storey (est.)
      </span>
      <Sep />
      <span className={`shrink-0 ${conflicts.length ? 'text-red-400' : ''}`}>
        {conflicts.length} conflicts
      </span>
      {activeProps ? (
        <>
          <Sep />
          <span
            className="hidden shrink-0 font-mono text-[rgb(var(--ink))] lg:inline"
            title={`Parcel ${parcelUlpin ?? '—'}`}
          >
            {activeProps.ulpin}
          </span>
        </>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <ScaleBar heightM={camHeight} />
        {/* Terrain and basemap are independent now: imagery needs no ion
            token, and the basemap can differ from the one picked if a
            provider failed over. Report both rather than conflating them. */}
        {/* Photoreal supplies both surfaces itself: the globe is hidden and
            World Terrain is off while it is up, so naming the basemap and
            terrain underneath it would credit two sources that are not on
            screen. */}
        {buildingStyle === 'photoreal' ? (
          <>
            <span className="hidden xl:inline">Google Photorealistic 3D Tiles</span>
            <Sep />
            <span className="hidden xl:inline">Terrain from tiles</span>
          </>
        ) : (
          <>
            <span
              className={`hidden sm:inline ${imageryActive !== imageryProvider ? 'text-amber-300/90' : ''}`}
            >
              {PROVIDER_LABELS[imageryActive]}
              {imageryActive !== imageryProvider ? ' (fallback)' : ''}
            </span>
            <Sep />
            {ionFallback ? (
              <span className="hidden sm:inline text-amber-300/90">Ellipsoid · no terrain</span>
            ) : (
              <span className="hidden sm:inline">Cesium World Terrain</span>
            )}
          </>
        )}
        <Sep />
        <span className="shrink-0 uppercase tracking-wide text-[rgb(var(--ink))]">
          {underground ? 'underground' : mode}
        </span>
      </span>
    </div>
  );
}

function Sep() {
  return <span className="hidden shrink-0 text-[rgb(var(--edge))] sm:inline">|</span>;
}

/**
 * A small scale bar that picks the nearest "round" tick to the camera height.
 * With a 60° FOV at this latitude, 100 px on screen corresponds to
 * approximately `0.88 * heightM` metres of ground -- so we choose a tick of
 * 10, 50, 100, 250, 500, 1000, 2000, 5000 m whose screen length is in
 * [40, 200] px.
 */
function ScaleBar({ heightM }: { heightM: number }) {
  const TICKS = [10, 50, 100, 250, 500, 1000, 2000, 5000];
  // Choose the tick nearest the camera height in log space.
  let best = TICKS[0];
  let bestDelta = Infinity;
  for (const t of TICKS) {
    const ratio = t / Math.max(1, heightM);
    // Prefer ratios in [0.05, 0.5] (a tick should be 5–50% of the camera height).
    const d = ratio < 0.05 ? 0.05 - ratio : ratio > 0.5 ? ratio - 0.5 : 0;
    if (d < bestDelta) { bestDelta = d; best = t; }
  }
  // Render width in pixels: 100 px is `~0.5 * heightM` m at this AOI latitude.
  const widthPx = Math.max(40, Math.min(180, 100 * (best / Math.max(1, heightM)) * 2));
  return (
    <span className="flex items-center gap-1" title={`Camera height: ${heightM.toFixed(0)} m`}>
      <svg width={Math.round(widthPx)} height={8} className="text-[rgb(var(--ink))]">
        <rect
          x={0} y={2} width={Math.round(widthPx)}
          height={4} fill="currentColor" opacity={0.85}
        />
        <rect
          x={0} y={2} width={Math.round(widthPx / 2)}
          height={4} fill="transparent" stroke="currentColor" strokeWidth={0.5}
        />
      </svg>
      <span className="text-[rgb(var(--ink))]">{best} m</span>
    </span>
  );
}
