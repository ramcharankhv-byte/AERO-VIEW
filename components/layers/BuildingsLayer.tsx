'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { toSceneZ } from '@/lib/cesium/terrain';
import { flatLonLat } from '@/lib/geo';
import type { UseType } from '@/lib/types';

/**
 * All 384 footprints, extruded.
 *
 * Reads the store, renders. Never writes to it and never moves the camera.
 *
 * Performance note: entities are built ONCE. State changes (hover, fade,
 * hiding the active building) are expressed through CallbackProperty closures
 * that read a single mutable ref, and one requestAnimationFrame loop eases the
 * fade value. That is one animation driver for the whole layer instead of 384
 * competing tweens, and it avoids rebuilding geometry on every selection.
 */

interface LayerState {
  activeId: number | null;
  hoveredId: number | null;
  fade: number;        // current eased alpha for non-active buildings
  fadeTarget: number;
  visible: boolean;
  hideActive: boolean;
}

const FADE_RATE = 0.12;   // per frame, ~600 ms to settle

export default function BuildingsLayer() {
  const { viewer, ground, ready } = useViewer();
  const buildings = useDataStore((s) => s.buildings);

  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const hoveredBuildingId = useViewStore((s) => s.hoveredBuildingId);
  const transparency = useViewStore((s) => s.transparency);
  const underground = useViewStore((s) => s.underground);
  const showBuildings = useViewStore((s) => s.layers.buildings);

  const stateRef = useRef<LayerState>({
    activeId: null, hoveredId: null, fade: 1, fadeTarget: 1,
    visible: true, hideActive: false,
  });
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  // ---- build entities once -------------------------------------------------
  useEffect(() => {
    if (!viewer || !ready || !buildings || viewer.isDestroyed()) return;

    const ds = new Cesium.CustomDataSource('buildings');
    dsRef.current = ds;
    viewer.dataSources.add(ds);

    for (const feature of buildings.features) {
      const props = feature.properties;
      const ring = (feature.geometry.coordinates as number[][][])[0];
      const flat = flatLonLat(ring);
      if (flat.length < 6) continue;

      const terrainH = ground.get(props.id);
      const base = toSceneZ(props.ground_elev, props.ground_elev, terrainH);
      const use = props.use_type as UseType;
      const id = props.id;

      const entity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: base,
          extrudedHeight: base + Math.max(2, props.height_m),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const s = stateRef.current;
              if (s.hoveredId === id) return MATERIALS.buildingHover.withAlpha(0.95);
              if (s.activeId === null) return MATERIALS.buildingDefault(use);
              if (s.activeId === id) return MATERIALS.buildingDefault(use);
              return MATERIALS.buildingFaded(use, s.fade);
            }, false),
          ),
          outline: false,
          shadows: Cesium.ShadowMode.DISABLED,
          show: new Cesium.CallbackProperty(() => {
            const s = stateRef.current;
            if (!s.visible) return false;
            // In building/floor/unit mode the active building's single
            // extrusion is replaced by its floor stack, so it must go.
            if (s.hideActive && s.activeId === id) return false;
            return true;
          }, false),
        },
      });
      tagEntity(entity, { kind: 'building', id });
    }

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, buildings, ground]);

  // ---- push store state into the render closure ----------------------------
  useEffect(() => {
    const s = stateRef.current;
    s.activeId = activeBuildingId;
    s.hoveredId = hoveredBuildingId;
    s.visible = showBuildings;
    s.hideActive = mode !== 'city';
    // 15% in underground mode, otherwise the transparency slider (default 12%).
    s.fadeTarget =
      underground ? 0.15 : activeBuildingId === null ? 1 : transparency / 100;
  }, [activeBuildingId, hoveredBuildingId, showBuildings, mode, transparency, underground]);

  // ---- one animation driver for the whole layer ---------------------------
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const s = stateRef.current;
      const delta = s.fadeTarget - s.fade;
      if (Math.abs(delta) > 0.002) {
        s.fade += delta * FADE_RATE;
      } else {
        s.fade = s.fadeTarget;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return null;
}
