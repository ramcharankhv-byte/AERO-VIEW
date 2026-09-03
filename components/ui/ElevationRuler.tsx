'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useEnsureDetail, useViewStore } from '@/lib/store';
import { liftFor } from '@/lib/cesium/explode';
import { levelLabel } from '@/lib/ulpin';
import { toSceneZ } from '@/lib/cesium/terrain';
import { ringCentroid } from '@/lib/geo';

/**
 * DOM elevation ruler pinned to the active building.
 *
 * Each tick is projected from its true world position to screen space every
 * frame, so the ruler tracks the building through camera moves and through the
 * explode animation rather than being a static graphic.
 */

interface Tick {
  key: number;
  x: number;
  y: number;
  label: string;
  z: number;
  basement: boolean;
}

/** Cesium renamed this helper; support both spellings. */
function toWindow(
  scene: Cesium.Scene,
  pos: Cesium.Cartesian3,
): Cesium.Cartesian2 | undefined {
  const T = Cesium.SceneTransforms as unknown as Record<
    string,
    (s: Cesium.Scene, p: Cesium.Cartesian3) => Cesium.Cartesian2 | undefined
  >;
  const fn = T.worldToWindowCoordinates ?? T.wgs84ToWindowCoordinates;
  return fn ? fn(scene, pos) : undefined;
}

export default function ElevationRuler() {
  const { viewer, ground, ready } = useViewer();
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const explodeT = useViewStore((s) => s.explodeT);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const underground = useViewStore((s) => s.underground);
  const buildings = useDataStore((s) => s.buildings);
  const detail = useEnsureDetail(mode === 'city' ? null : activeBuildingId);

  const [ticks, setTicks] = useState<Tick[]>([]);
  const explodeRef = useRef(explodeT);
  useEffect(() => {
    explodeRef.current = explodeT;
  }, [explodeT]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    // Hidden in city mode (nothing to measure) and underground (the ruler
    // measures the above-ground stack, which is not what is on screen).
    if (!detail || mode === 'city' || underground || activeBuildingId === null) {
      setTicks([]);
      return;
    }

    const feature = buildings?.features.find(
      (f) => f.properties.id === activeBuildingId,
    );
    if (!feature) return;
    const bprops = feature.properties;

    // Anchor the ruler at one corner of the footprint so it does not sit on
    // top of the stack it is measuring.
    const ring = (feature.geometry.coordinates as number[][][])[0];
    const { lon: cLon, lat: cLat } = ringCentroid(ring);
    const n = Math.max(1, ring.length - 1);
    let minLon = ring[0][0];
    for (let i = 0; i < n; i++) minLon = Math.min(minLon, ring[i][0]);
    const anchorLon = minLon - (cLon - minLon) * 0.25;
    const lon = cLon;
    const lat = cLat;

    const terrainH = ground.get(activeBuildingId);
    const floors = [...detail.floors].sort((a, b) => a.level_no - b.level_no);
    const top = bprops.floors - 1;

    const update = () => {
      if (viewer.isDestroyed()) return;
      const next: Tick[] = [];
      floors.forEach((f, index) => {
        const lift = f.level_no < 0 ? 0 : liftFor(index, explodeRef.current);
        const z = toSceneZ(f.z_min, bprops.ground_elev, terrainH) + lift;
        const win = toWindow(
          viewer.scene,
          Cesium.Cartesian3.fromDegrees(anchorLon, lat, z),
        );
        if (!win) return;
        next.push({
          key: f.id,
          x: win.x,
          y: win.y,
          label: levelLabel(f.level_no, top),
          z: f.z_min,
          basement: f.level_no < 0,
        });
      });
      setTicks(next);
    };

    viewer.scene.postRender.addEventListener(update);
    update();
    return () => {
      if (!viewer.isDestroyed()) viewer.scene.postRender.removeEventListener(update);
    };
  }, [viewer, ready, ground, detail, activeBuildingId, mode, underground, buildings]);

  if (ticks.length === 0) return null;

  const ys = ticks.map((t) => t.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spineX = ticks[0].x;

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {/* spine */}
      <div
        className="absolute w-px bg-[rgb(var(--accent))]/40"
        style={{
          left: `${spineX}px`,
          top: `${minY}px`,
          height: `${Math.max(1, maxY - minY)}px`,
        }}
      />
      {ticks.map((t) => (
        <div
          key={t.key}
          className="absolute flex items-center gap-1"
          style={{ left: `${t.x}px`, top: `${t.y}px` }}
        >
          <span
            className={[
              'h-px',
              t.basement ? 'w-2 bg-[rgb(var(--muted))]' : 'w-3 bg-[rgb(var(--accent))]/70',
              isolatedFloor !== null ? 'opacity-60' : '',
            ].join(' ')}
          />
          <span
            className={[
              'whitespace-nowrap rounded bg-[rgb(var(--panel)/0.85)] px-1 text-[9px] leading-[1.4] backdrop-blur-sm',
              t.basement ? 'text-[rgb(var(--muted))]' : 'text-[rgb(var(--ink))]',
            ].join(' ')}
          >
            {t.label} · {t.z.toFixed(1)} m
          </span>
        </div>
      ))}
    </div>
  );
}
