'use client';

import { useMemo } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';

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
    let cx = 0;
    let cy = 0;
    const n = Math.max(1, ring.length - 1);
    for (let i = 0; i < n; i++) {
      cx += ring[i][0];
      cy += ring[i][1];
    }
    cx /= n;
    cy /= n;

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
    <div className="glass pointer-events-auto rounded-lg p-2.5">
      <div className="flex items-center justify-between">
        <span className="panel-title">Parcel context</span>
        <span className="font-mono text-[9px] text-[rgb(var(--muted))]">
          {WINDOW_M * 2} m
        </span>
      </div>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        className="mt-1.5 rounded bg-black/30"
      >
        {view.neighbours
          .filter((p) => !p.selected)
          .map((p) => (
            <path
              key={`n${p.id}`}
              d={p.d}
              fill="rgba(140,170,200,0.06)"
              stroke="rgba(140,170,200,0.35)"
              strokeWidth="0.7"
            />
          ))}
        {view.buildings.map((b) => (
          <path
            key={`b${b.id}`}
            d={b.d}
            fill={b.active ? 'rgba(240,190,72,0.55)' : 'rgba(160,180,205,0.22)'}
            stroke="none"
          />
        ))}
        {view.neighbours
          .filter((p) => p.selected)
          .map((p) => (
            <path
              key={`s${p.id}`}
              d={p.d}
              fill="rgba(120,235,180,0.16)"
              stroke="rgb(120,235,180)"
              strokeWidth="1.6"
            />
          ))}
      </svg>
      <div className="mt-1.5 flex items-center gap-3 text-[9px] text-[rgb(var(--muted))]">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm border border-[rgb(120,235,180)]" />
          selected plot
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-[rgba(240,190,72,0.7)]" />
          building
        </span>
      </div>
    </div>
  );
}
