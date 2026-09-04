'use client';

import { useDataStore, useViewStore } from '@/lib/store';
import { useViewer } from '../globe/CesiumRoot';
import { PROVIDER_LABELS } from '@/lib/cesium/imagery-catalog';
import { useCameraHeight } from '@/lib/cesium/setup';

/** Bottom bar: coordinate system, scale, accuracy and the real building count. */
export default function StatusBar({
  /**
   * Narrow layouts drop the lower-priority readouts rather than letting a
   * ten-child single-line flex overflow.
   *
   * The building count and the place name are NEVER dropped: scripts/
   * verify_ui.mjs asserts on both, and they are the two facts that say what
   * you are looking at. Dropping the imagery/terrain name is not a licence
   * problem -- the actual attribution lives in Cesium's own credit container,
   * which is repositioned but never hidden (see .cesium-viewer-bottom).
   */
  dense = false,
}: { dense?: boolean } = {}) {
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
  /**
   * The project's name.
   *
   * Read off the FeatureCollection rather than added to the view store: the
   * buildings query already returns it in `aoi` on BOTH backends, so it is
   * here for free and cannot disagree with the data on screen. The store
   * gained exactly one field for projects, and this is not it.
   */
  const projectName = buildings?.aoi ?? null;
  const activeProps = activeBuildingId !== null
    ? buildings?.features.find((f) => f.properties.id === activeBuildingId)?.properties
    : null;
  const parcelUlpin = activeBuildingId !== null ? detail[activeBuildingId]?.parcel?.ulpin : null;

  return (
    <div
      data-panel="status"
      className="glass pointer-events-auto flex h-7 items-center gap-2 overflow-hidden whitespace-nowrap rounded-lg px-3 text-[10px] text-[rgb(var(--muted))] sm:gap-3"
    >
      <span className="font-medium text-[rgb(var(--ink))]">{count} 3D buildings</span>
      <Sep />
      {projectName ? <span>{projectName}</span> : null}
      {dense ? null : (
        <>
          <Sep />
          <span className="hidden xl:inline">WGS 84 / EPSG:4326 · Z in metres</span>
          <Sep />
          <span className="hidden 2xl:inline">AOI 1.22 × 1.11 km</span>
          <Sep />
          {/* Stated honestly: heights are mostly inferred, not measured. */}
          <span
            className="hidden 2xl:inline"
            title="90% of heights are inferred from footprint area and building tag"
          >
            Height accuracy ±1 storey (est.)
          </span>
          <Sep />
        </>
      )}
      <span className={conflicts.length ? 'text-dangerInk' : ''}>
        {conflicts.length} conflicts
      </span>
      {activeProps ? (
        <>
          <Sep />
          <span
            className="font-mono text-[rgb(var(--ink))]"
            title={`Parcel ${parcelUlpin ?? '—'}`}
          >
            {activeProps.ulpin}
          </span>
        </>
      ) : null}
      <span className="ml-auto flex items-center gap-3">
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
            <span>Google Photorealistic 3D Tiles</span>
            <Sep />
            <span>Terrain from tiles</span>
          </>
        ) : (
          <>
            <span className={imageryActive !== imageryProvider ? 'font-medium text-ink' : ''}>
              {PROVIDER_LABELS[imageryActive]}
              {imageryActive !== imageryProvider ? ' (fallback)' : ''}
            </span>
            <Sep />
            {ionFallback ? (
              <span className="font-medium text-ink">Ellipsoid · no terrain</span>
            ) : (
              <span>Cesium World Terrain</span>
            )}
          </>
        )}
        <Sep />
        <span className="uppercase tracking-wide text-[rgb(var(--ink))]">
          {underground ? 'underground' : mode}
        </span>
      </span>
    </div>
  );
}

function Sep() {
  return <span className="text-[rgb(var(--edge))]">|</span>;
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
