'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { BUILDING_ALPHA, MATERIALS } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { toSceneZ } from '@/lib/cesium/terrain';
import { flatLonLat } from '@/lib/geo';
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
  // The EPOCH, not the collection.
  //
  // Editing one building's attributes gives `buildings` a new object identity.
  // Depending on it here would tear down and rebuild all 768 entities -- with
  // a fresh ImageMaterialProperty and a texture lookup each -- for a one-field
  // change, which is exactly the cost this layer is built to avoid, paid the
  // instant the user clicks Save. The epoch changes only on a genuine reload;
  // an attribute edit is applied to the one affected building below.
  //
  // Reading the collection imperatively inside the effect is the same idiom
  // useEnsureDetail documents in lib/store.ts for the same reason.
  const buildingsEpoch = useDataStore((s) => s.buildingsEpoch);
  const buildingsLoaded = useDataStore((s) => s.buildings !== null);

  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const hoveredBuildingId = useViewStore((s) => s.hoveredBuildingId);
  const transparency = useViewStore((s) => s.transparency);
  const underground = useViewStore((s) => s.underground);
  const showBuildings = useViewStore((s) => s.layers.buildings);
  const buildingStyle = useViewStore((s) => s.buildingStyle);
  // Shadows are scoped to the buildings: they are what reads as massing under a
  // low sun, and every extra casting layer is another depth pass per frame.
  const sunHour = useViewStore((s) => s.sunHour);

  const stateRef = useRef<LayerState>({
    activeId: null, hoveredId: null, fade: 1, fadeTarget: 1,
    visible: true, hideActive: false, style: 'schematic',
  });
  /**
   * Shadow mode, shared by every building entity.
   *
   * One mutable ConstantProperty rather than a CallbackProperty per entity: a
   * non-constant shadows property pushes the geometry onto Cesium's dynamic
   * updater path, which rebuilds 384 extrusions every frame. setValue() fires
   * definitionChanged once and the static path is kept.
   */
  const shadowsRef = useRef(new Cesium.ConstantProperty(Cesium.ShadowMode.DISABLED));
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);
  /**
   * buildingId -> the entities and the constants needed to re-shape it.
   *
   * Populated during the build pass so a single edited building can be updated
   * in place, without a lookup through the whole data source.
   */
  const entitiesRef = useRef(new Map<number, {
    wall: Cesium.Entity;
    cap: Cesium.Entity;
    base: number;
  }>());

  // ---- build entities once -------------------------------------------------
  useEffect(() => {
    if (!viewer || !ready || !buildingsLoaded || viewer.isDestroyed()) return;
    const buildings = useDataStore.getState().buildings;
    if (!buildings) return;

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

      // A FLAT wall colour, not a facade texture.
      //
      // These masses are drawn at BUILDING_ALPHA over live satellite imagery,
      // and a repeating window grid at that opacity beats against the pixels
      // underneath instead of describing a building -- 384 of them turned the
      // city view into moire. Fenestration is now the job of the architectural
      // model of the ONE building being inspected, which is opaque and seen
      // from close enough to resolve it (BuildingModelLayer). At city scale
      // what has to read is the SILHOUETTE and its shadow, so that is all this
      // draws.
      //
      // `fade` is clamped rather than multiplied: it is an absolute alpha for
      // the buildings you are not inspecting, so clamping keeps "faded" below
      // "at rest" without ever multiplying two transparencies into nothing.
      const wallColor = new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(() => {
          const s = stateRef.current;
          // Photoreal: present for picking, invisible on screen. Checked first
          // so neither hover nor fade can bring the ghost back into view.
          if (s.style === 'photoreal') return MATERIALS.buildingGhost;
          if (s.hoveredId === id) return MATERIALS.buildingHover.withAlpha(0.85);
          if (s.activeId === null || s.activeId === id) {
            return MATERIALS.buildingFacade(use);
          }
          return MATERIALS.buildingFacade(use, Math.min(BUILDING_ALPHA, s.fade));
        }, false),
      );

      const entity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: base,
          extrudedHeight: base + Math.max(2, props.height_m),
          material: wallColor,
          outline: false,
          shadows: shadowsRef.current,
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
      const wallEntity = entity;

      // Roof cap: a flat plate 0.05 m above the wall top, one value step down
      // from the wall. With a raking sun the cap is the face that catches the
      // light while the walls fall into shade, which is most of what makes the
      // height legible from above; the faded callback keeps the whole building
      // (walls + cap) dissolving together.
      const capTop = base + Math.max(2, props.height_m) + 0.05;
      const capEntity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: capTop - 0.1,
          extrudedHeight: capTop,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const s = stateRef.current;
              if (s.style === 'photoreal') return MATERIALS.buildingGhost;
              if (s.hoveredId === id) return MATERIALS.buildingHover.withAlpha(0.85);
              if (s.activeId === null || s.activeId === id) {
                return MATERIALS.buildingRoofCap(use);
              }
              return MATERIALS.buildingRoofCap(use, Math.min(BUILDING_ALPHA, s.fade));
            }, false),
          ),
          outline: false,
          shadows: shadowsRef.current,
          show: new Cesium.CallbackProperty(() => {
            const s = stateRef.current;
            if (!s.visible) return false;
            if (s.hideActive && s.activeId === id) return false;
            return true;
          }, false),
        },
      });

      entitiesRef.current.set(id, { wall: wallEntity, cap: capEntity, base });
    }

    return () => {
      entitiesRef.current.clear();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, buildingsLoaded, buildingsEpoch, ground]);

  /**
   * Re-shape ONE building when its height or storey count is edited.
   *
   * Assigning a fresh ConstantProperty fires definitionChanged once and Cesium
   * re-creates that single primitive; the other 383 keep their static geometry
   * and are not touched. The properties deliberately stay CONSTANT rather than
   * becoming CallbackProperties -- a non-constant geometry property would push
   * every extrusion onto the dynamic updater and rebuild the lot every frame,
   * which is the trap documented on `shadows` above.
   */
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const unsubscribe = useDataStore.subscribe((state, prev) => {
      if (state.buildings === prev.buildings) return;
      if (state.buildingsEpoch !== prev.buildingsEpoch) return; // full reload
      const prevById = new Map(
        (prev.buildings?.features ?? []).map((f) => [f.properties.id, f.properties]),
      );
      let touched = false;
      for (const f of state.buildings?.features ?? []) {
        const now = f.properties;
        const before = prevById.get(now.id);
        if (!before) continue;
        if (before.height_m === now.height_m && before.floors === now.floors) continue;
        const rec = entitiesRef.current.get(now.id);
        if (!rec) continue;

        // Height only. The wall material is a flat colour now, so an edited
        // storey count changes the panel and the floor stack but has nothing
        // to re-tile on the extrusion itself.
        const top = rec.base + Math.max(2, now.height_m);
        if (rec.wall.polygon) {
          rec.wall.polygon.extrudedHeight = new Cesium.ConstantProperty(top);
        }
        if (rec.cap.polygon) {
          const capTop = top + 0.05;
          rec.cap.polygon.height = new Cesium.ConstantProperty(capTop - 0.1);
          rec.cap.polygon.extrudedHeight = new Cesium.ConstantProperty(capTop);
        }
        touched = true;
      }
      if (touched && !viewer.isDestroyed()) viewer.scene.requestRender();
    });
    return unsubscribe;
  }, [viewer]);

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

  // Shadows follow the sun slider. Off until it is touched.
  useEffect(() => {
    shadowsRef.current.setValue(
      sunHour === null ? Cesium.ShadowMode.DISABLED : Cesium.ShadowMode.ENABLED,
    );
    if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
  }, [sunHour, viewer]);

  // ---- one animation driver for the whole layer ---------------------------
  // Parks itself once the fade has settled rather than spinning for the life
  // of the page. The scene renders on demand (requestRenderMode), so a loop
  // that keeps waking every frame to compare two equal numbers is pure cost --
  // it kept a laptop's GPU and main thread out of idle on a static view. It is
  // restarted by the effect above whenever fadeTarget actually moves.
  const fadeTarget = underground ? 0.15 : activeBuildingId === null ? 1 : transparency / 100;
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const s = stateRef.current;
      const delta = s.fadeTarget - s.fade;
      if (Math.abs(delta) <= 0.002) {
        s.fade = s.fadeTarget;
        raf = 0;
        return;                       // settled: stop until the target moves
      }
      s.fade += delta * FADE_RATE;
      if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [fadeTarget, viewer]);

  return null;
}
