'use client';

import { useMemo } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import { ringCentroid } from '@/lib/geo';

/**
 * 2D parcel-context inset: the selected plot highlighted among its neighbours.
 *
 * Pure SVG over the parcel GeoJSON -- no second map engine. The window is a
 * fixed metric radius around the selected parcel so the sense of scale stays
 * constant as you move between plots.
 */

const WINDOW_M = 130;
const SIZE = 178;

export default function ParcelInset() {
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const parcels = useDataStore((s) => s.parcels);
  const buildings = useDataStore((s) => s.buildings);

  const view = useMemo(() => {
    if (!parcels || !buildings || activeBuildingId === null) return null;
    const bprops = buildings.features.find(
      (f) => f.properties.id === activeBuildingId,
    )?.properties;
    if (!bprops) return null;

    const target = parcels.features.find((f) => f.properties.id === bprops.parcel_id);
    if (!target) return null;

    // Centre on the selected parcel.
    const ring = (target.geometry.coordinates as number[][][])[0];
    const { lon: cx, lat: cy } = ringCentroid(ring);

    const mPerDegLat = 110574;
    const mPerDegLon = 111320 * Math.cos((cy * Math.PI) / 180);
    const dLon = WINDOW_M / mPerDegLon;
    const dLat = WINDOW_M / mPerDegLat;

    const project = (lon: number, lat: number) => [
      ((lon - (cx - dLon)) / (2 * dLon)) * SIZE,
      SIZE - ((lat - (cy - dLat)) / (2 * dLat)) * SIZE,
    ];

    const toPath = (r: number[][]) =>
      r
        .map((p, i) => {
          const [x, y] = project(p[0], p[1]);
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ') + ' Z';

    const near = parcels.features.filter((f) => {
      const r = (f.geometry.coordinates as number[][][])[0];
      return r.some(
        (p) => Math.abs(p[0] - cx) < dLon * 1.2 && Math.abs(p[1] - cy) < dLat * 1.2,
      );
    });

    const footprints = buildings.features.filter((f) => {
      const r = (f.geometry.coordinates as number[][][])[0];
      return r.some(
        (p) => Math.abs(p[0] - cx) < dLon * 1.2 && Math.abs(p[1] - cy) < dLat * 1.2,
      );
    });

    return {
      target,
      neighbours: near.map((f) => ({
        id: f.properties.id,
        d: toPath((f.geometry.coordinates as number[][][])[0]),
        selected: f.properties.id === bprops.parcel_id,
      })),
      buildings: footprints.map((f) => ({
        id: f.properties.id,
        d: toPath((f.geometry.coordinates as number[][][])[0]),
        active: f.properties.id === activeBuildingId,
      })),
    };
  }, [parcels, buildings, activeBuildingId]);

  if (mode === 'city' || !view) return null;

  return (
    <div data-panel="parcel-inset" className="glass pointer-events-auto rounded-lg p-2.5">
      <div className="flex items-center justify-between">
        <span className="panel-title">Parcel context</span>
        <span className="font-mono text-[9px] text-[rgb(var(--muted))]">
          {WINDOW_M * 2} m
        </span>
      </div>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={`mt-1.5 h-auto w-full max-w-[${SIZE}px] rounded bg-[rgb(var(--surface-2))]`}
      >
        {view.neighbours
          .filter((p) => !p.selected)
          .map((p) => (
            <path
              key={`n${p.id}`}
              d={p.d}
              fill="rgb(var(--ink) / 0.06)"
              stroke="rgb(var(--ink) / 0.30)"
              strokeWidth="0.7"
            />
          ))}
        {view.buildings.map((b) => (
          <path
            key={`b${b.id}`}
            d={b.d}
            fill={b.active ? 'rgb(var(--ink) / 0.85)' : 'rgb(var(--ink) / 0.22)'}
            stroke="none"
          />
        ))}
        {view.neighbours
          .filter((p) => p.selected)
          .map((p) => (
            <path
              key={`s${p.id}`}
              d={p.d}
              fill="rgb(var(--ink) / 0.12)"
              stroke="rgb(var(--ink))"
              strokeWidth="1.6"
            />
          ))}
      </svg>
      <div className="mt-1.5 flex items-center gap-3 text-[9px] text-[rgb(var(--muted))]">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm border border-[rgb(var(--ink))]" />
          selected plot
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-[rgb(var(--ink))]" />
          building
        </span>
      </div>
    </div>
  );
}
