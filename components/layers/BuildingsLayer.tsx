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
import { mark } from '@/lib/boot-marks';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import { createBucketGrid, extentOf } from '@/lib/cesium/spatial-buckets';
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

/**
 * Distance beyond which the near (entity) tier hands off to the far-tier
 * primitive. 1500 m: a 50 m footprint is ~60 px wide on the 1680x950 viewport
 * the probe uses, so the silhouette still reads, and the far tier takes over
 * before a Hyderabad orbit pulls 4,426 entities on screen at once. The two
 * tiers' DDCs are back-to-back at this number; nothing is rendered twice.
 *
 * Constant -- a `new` per entity would still be static geometry but wastes the
 * per-instance comparison Cesium does. One shared object, every entity.
 */
const FAR_M = 1500;
const NEAR_DDC = new Cesium.DistanceDisplayCondition(0, FAR_M);

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
  /**
   * The bucket grid this layer draws into.
   *
   * Not one data source any more -- see lib/cesium/spatial-buckets.ts for why
   * a single batched primitive spanning the AOI can never be frustum-culled.
   */
  const gridRef = useRef<ReturnType<typeof createBucketGrid> | null>(null);
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
  /**
   * Latches to false in the build effect's cleanup, before any other teardown.
   * The cancel call below stops future slices from being scheduled; the alive
   * flag stops the one that already passed the cancel point. Without it a
   * late `addFootprint` slice can call `ds.entities.add(...)` on a disposed
   * bucket, leaking entities into the (now-orphaned) data source, and the
   * `onDone` mark can fire on a layer that no longer exists.
   */
  const aliveRef = useRef(true);

  // ---- build entities once -------------------------------------------------
  useEffect(() => {
    if (!viewer || !ready || !buildingsLoaded || viewer.isDestroyed()) return;
    const buildings = useDataStore.getState().buildings;
    if (!buildings) return;

    const grid = createBucketGrid(
      viewer,
      'buildings',
      extentOf(buildings.features.map((f) => {
        const ring = (f.geometry.coordinates as number[][][])[0];
        return [ring[0][0], ring[0][1]] as const;
      })),
    );
    gridRef.current = grid;

    /**
     * One footprint. Called by the incremental builder, a slice at a time.
     *
     * This body is exactly what it was when it ran inside a `for` loop; the
     * only change is who drives the loop. At 2,597 buildings -- 5,194 entities
     * with a PolygonHierarchy, two material closures and two show closures
     * each -- running it to completion in one task blocked the main thread for
     * 3.7 seconds (docs/perf/findings.md). Nothing about the work was wrong;
     * doing all of it between two paints was.
     */
    const addFootprint = (feature: typeof buildings.features[number]) => {
      // Late slice after teardown: skip the entity add so we do not write
      // into a disposed bucket. The next effect run (if any) will rebuild
      // from scratch. See aliveRef declaration above.
      if (!aliveRef.current) return;
      const props = feature.properties;
      const ring = (feature.geometry.coordinates as number[][][])[0];
      const flat = flatLonLat(ring);
      if (flat.length < 6) return;

      const terrainH = ground.get(props.id);
      const base = toSceneZ(props.ground_elev, props.ground_elev, terrainH);
      const use = props.use_type as UseType;
      const id = props.id;
      // Both entities for a building go in the same bucket, chosen from its
      // first vertex: a footprint is far smaller than a cell, so which vertex
      // decides is immaterial, and keeping the pair together means a cull can
      // never drop a wall while keeping its roof.
      const ds = grid.forPoint(ring[0][0], ring[0][1]);

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
          // Static: handed to the far-tier primitive past FAR_M. Sharing one
          // ConstantProperty across every entity keeps the geometry on the
          // static updater path (a non-constant DDC would push every
          // extrusion onto the dynamic updater and rebuild the lot per frame).
          distanceDisplayCondition: NEAR_DDC,
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
          distanceDisplayCondition: NEAR_DDC,
          show: new Cesium.CallbackProperty(() => {
            const s = stateRef.current;
            if (!s.visible) return false;
            if (s.hideActive && s.activeId === id) return false;
            return true;
          }, false),
        },
      });

      entitiesRef.current.set(id, { wall: wallEntity, cap: capEntity, base });
    };

    // The first slice is sized rather than timed. A few hundred footprints put
    // recognisable massing on screen in the same task the effect runs in, which
    // is what stops the city from appearing to pop in from nothing; after that
    // the builder falls back to its frame budget and the browser stays
    // responsive for the remaining few thousand.
    const cancelBuild = buildIncrementally({
      items: buildings.features,
      step: addFootprint,
      firstSlice: 250,
      // Each slice is only visible if the scene is asked for a frame: the
      // viewer runs in requestRenderMode, so without this the entities would
      // all appear at once when something else happened to trigger a render.
      onSlice: () => {
        if (!aliveRef.current) return;
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
      onDone: () => {
        // The effect was torn down between the last slice and now. The mark
        // would otherwise land on a layer that no longer exists; the boot
        // timeline would then show a "buildings-built" time for a viewer
        // that was disposed before the mark fired.
        if (!aliveRef.current) return;
        mark('buildings-built');
      },
    });

    return () => {
      // Alive goes first: any slice still in flight when cancelBuild() runs
      // sees false on its next read and short-circuits. The dispose calls
      // below are the matching teardown for the slices that already
      // completed.
      aliveRef.current = false;
      cancelBuild();
      entitiesRef.current.clear();
      grid.dispose();
      gridRef.current = null;
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
