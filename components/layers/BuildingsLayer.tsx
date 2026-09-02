'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { toSceneZ } from '@/lib/cesium/terrain';
import { windowGrid } from '@/lib/cesium/textures';
import { flatLonLat, orientedDims } from '@/lib/geo';
import type { BuildingStyle, UseType } from '@/lib/types';

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
 *
 * Building style is part of that same closure rather than a rebuild. In
 * Photoreal mode these extrusions do not go away -- they drop to alpha 0.01
 * and keep rendering underneath Google's mesh, because scene.pick does not hit
 * an entity with show:false. Everything downstream of a pick (the ULPIN card,
 * the floor ladder, the basement conflict list) therefore keeps working with
 * no photoreal-specific code path anywhere else in the app.
 */

interface LayerState {
  activeId: number | null;
  hoveredId: number | null;
  fade: number;        // current eased alpha for non-active buildings
  fadeTarget: number;
  visible: boolean;
  hideActive: boolean;
  style: BuildingStyle;
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
  const buildingStyle = useViewStore((s) => s.buildingStyle);

  const stateRef = useRef<LayerState>({
    activeId: null, hoveredId: null, fade: 1, fadeTarget: 1,
    visible: true, hideActive: false, style: 'schematic',
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

      // One texture tile is one storey (textures.ts draws a 3.2 m tile, the
      // same floor-to-floor dimension build_geometry.sql uses), so repeating
      // it `floors` times up the wall lines the window bands up with the
      // storeys the DetailPanel reports. The storey count is the existing
      // inference from scripts/02_heights.py -- this reads it, it does not
      // re-derive it, so the +/-1 provenance caveat still describes the number
      // the user is looking at. Horizontally the repeat is derived from the
      // footprint's oriented width so the bay rhythm is metric everywhere,
      // including on the curved/irregular rings where a single tile used to
      // stretch into wide stripes.
      const storeys = Math.max(1, props.floors);
      const dims = orientedDims(ring);
      const baysX = Math.max(1, Math.round(dims.widthM / 4));
      const facade = new Cesium.ImageMaterialProperty({
        image: windowGrid(use),
        repeat: new Cesium.Cartesian2(baysX, storeys),
        // Alpha varies (fade, hover, the photoreal ghost), and Cesium routes a
        // material to the opaque pass unless it is told otherwise.
        transparent: true,
        color: new Cesium.CallbackProperty(() => {
          const s = stateRef.current;
          // Photoreal: present for picking, invisible on screen. Checked first
          // so neither hover nor fade can bring the ghost back into view.
          if (s.style === 'photoreal') return MATERIALS.buildingGhost;
          if (s.hoveredId === id) return MATERIALS.buildingHover.withAlpha(0.95);
          if (s.activeId === null) return MATERIALS.buildingFacade(use);
          if (s.activeId === id) return MATERIALS.buildingFacade(use);
          return MATERIALS.buildingFacade(use, s.fade);
        }, false),
      });

      const entity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: base,
          extrudedHeight: base + Math.max(2, props.height_m),
          material: facade,
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

      // Roof cap. Cesium stretches a polygon material over the whole extrusion
      // -- walls AND top -- so without this the facade's window grid prints on
      // every roof. A flat cap 0.05 m above the wall top in a muted roof tone
      // hides the printed face; the faded callback keeps the whole building
      // (walls + cap) dissolving together.
      const capTop = base + Math.max(2, props.height_m) + 0.05;
      ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: capTop - 0.1,
          extrudedHeight: capTop,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const s = stateRef.current;
              if (s.style === 'photoreal') return MATERIALS.buildingGhost;
              if (s.hoveredId === id) return MATERIALS.buildingHover.withAlpha(0.95);
              if (s.activeId === null) return MATERIALS.buildingRoofCap(use);
              if (s.activeId === id) return MATERIALS.buildingRoofCap(use);
              return MATERIALS.buildingRoofCap(use, s.fade);
            }, false),
          ),
          outline: false,
          shadows: Cesium.ShadowMode.DISABLED,
          show: new Cesium.CallbackProperty(() => {
            const s = stateRef.current;
            if (!s.visible) return false;
            if (s.hideActive && s.activeId === id) return false;
            return true;
          }, false),
        },
      });
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
    s.style = buildingStyle;
    // 15% in underground mode, otherwise the transparency slider (default 12%).
    // The slider only ever reaches schematic geometry: in photoreal mode the
    // colour callback returns the ghost before it consults `fade` at all, and
    // nothing here touches the tileset.
    s.fadeTarget =
      underground ? 0.15 : activeBuildingId === null ? 1 : transparency / 100;
  }, [activeBuildingId, hoveredBuildingId, showBuildings, mode, transparency,
      underground, buildingStyle]);

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
