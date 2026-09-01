'use client';

import { useDataStore, useViewStore } from '@/lib/store';

/** Bottom bar: coordinate system, scale, accuracy and the real building count. */
export default function StatusBar() {
  const buildings = useDataStore((s) => s.buildings);
  const conflicts = useDataStore((s) => s.conflicts);
  const mode = useViewStore((s) => s.mode);
  const underground = useViewStore((s) => s.underground);
  const ionFallback = useViewStore((s) => s.ionFallback);

  const count = buildings?.features.length ?? 0;

  return (
    <div className="glass pointer-events-auto flex h-7 items-center gap-3 rounded-lg px-3 text-[10px] text-[rgb(var(--muted))]">
      <span className="font-medium text-[rgb(var(--ink))]">{count} 3D buildings</span>
      <Sep />
      <span>Siripuram, Visakhapatnam</span>
      <Sep />
      <span>WGS 84 / EPSG:4326 · Z in metres</span>
      <Sep />
      <span>AOI 1.22 × 1.11 km</span>
      <Sep />
      {/* Stated honestly: heights are mostly inferred, not measured. */}
      <span title="90% of heights are inferred from footprint area and building tag">
        Height accuracy ±1 storey (est.)
      </span>
      <Sep />
      <span className={conflicts.length ? 'text-red-400' : ''}>
        {conflicts.length} conflicts
      </span>
      <span className="ml-auto flex items-center gap-3">
        {ionFallback ? (
          <span className="text-amber-300/90">OSM basemap · no terrain</span>
        ) : (
          <span>Cesium World Terrain</span>
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
