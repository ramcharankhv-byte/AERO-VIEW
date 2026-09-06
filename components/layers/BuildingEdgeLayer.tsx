'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { toSceneZ } from '@/lib/cesium/terrain';
import type { EnrichedBuilding, GeoFC } from '@/lib/types';

/**
 * The accent edge on the selected building, and the quiet one on the hovered
 * building.
 *
 * WHY THIS IS A LAYER AND NOT `outline: true`. The obvious implementation is
 * to turn the outline on for the one entity that is selected. It is also the
 * expensive one: an outlined polygon leaves Cesium's batched static geometry
 * path, so switching it on and off per selection re-batches the bucket the
 * building lives in, and the property has to be non-constant for every one of
 * the 2,213 entities that might one day be selected. The whole layer would pay,
 * on every click, to draw one building's edge.
 *
 * FOUR ENTITIES, drawn once and moved. Their positions come from
 * CallbackProperty closures reading a mutable ref, which is the same idiom
 * BuildingsLayer already uses for its fade -- so a selection change is a ref
 * write and a requestRender, not a rebuild. The entity count is constant: it
 * does not scale with the number of buildings, and it does not change when a
 * building is edited, which is what keeps check_edit's "entity count is
 * unchanged across a save" assertion true.
 *
 * WHY A WALL FOR THE CORNERS. `Cesium.WallGraphics` with `fill: false,
 * outline: true` draws exactly the edge set wanted -- the roof ring, the base
 * ring, and a vertical at every footprint vertex -- from a single entity,
 * where a polyline per corner would be one entity per vertex and a single
 * zig-zag polyline would draw diagonals across the roof.
 *
 * The wall's outline is a hairline and cannot be otherwise: WebGL on Windows
 * clamps `outlineWidth` to 1 px regardless of what is asked for, and ANGLE is
 * what this app runs on. That is why the roof ring is ALSO drawn as a real
 * polyline, which does honour its width -- the ring carries the weight, the
 * wall carries the corners.
 *
 * Reads the store, renders. Never writes to it, never moves the camera.
 */

interface EdgeState {
  /** Ring of the selected building, flat lon/lat, closed. Null when none. */
  selected: { flat: number[]; base: number; top: number } | null;
  hovered: { flat: number[]; base: number; top: number } | null;
  /** True when the selected building's real envelope is not what is drawn. */
  hideSelected: boolean;
  visible: boolean;
}

/** Parked far below the terrain: a Cesium polyline cannot have zero points. */
const PARKED = Cesium.Cartesian3.fromDegreesArrayHeights([0, 0, -1e6, 0.0001, 0, -1e6]);

export default function BuildingEdgeLayer() {
  const { viewer, ground, ready } = useViewer();

  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const hoveredBuildingId = useViewStore((s) => s.hoveredBuildingId);
  const showBuildings = useViewStore((s) => s.layers.buildings);
  const underground = useViewStore((s) => s.underground);
  const buildingStyle = useViewStore((s) => s.buildingStyle);
  const explodeT = useViewStore((s) => s.explodeT);
  const sliceOn = useViewStore((s) => s.slice.enabled);
  const buildingsEpoch = useDataStore((s) => s.buildingsEpoch);
  const buildingsLoaded = useDataStore((s) => s.buildings !== null);

  const stateRef = useRef<EdgeState>({
    selected: null, hovered: null, hideSelected: false, visible: true,
  });
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  // ---- build the four entities once ---------------------------------------
  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return undefined;
    const ds = new Cesium.CustomDataSource('building-edge');
    viewer.dataSources.add(ds);
    dsRef.current = ds;

    const ringAt = (which: 'selected' | 'hovered', top: boolean) =>
      new Cesium.CallbackProperty(() => {
        const s = stateRef.current;
        const b = s[which];
        if (!b || !s.visible) return PARKED;
        if (which === 'selected' && s.hideSelected) return PARKED;
        const z = top ? b.top : b.base;
        const out: number[] = [];
        for (let i = 0; i < b.flat.length; i += 2) out.push(b.flat[i], b.flat[i + 1], z);
        return Cesium.Cartesian3.fromDegreesArrayHeights(out);
      }, false) as unknown as Cesium.PositionProperty;

    // Casing under the roof ring: added FIRST so it draws first and the ring
    // sits on top of it. See MATERIALS.buildingSelectedEdgeCasing -- the roof
    // it traces is near-white under a low sun, and a white ring on a white
    // roof is invisible exactly where the user is looking.
    ds.entities.add({
      polyline: {
        positions: ringAt('selected', true),
        width: 6,
        material: new Cesium.ColorMaterialProperty(
          MATERIALS.buildingSelectedEdgeCasing,
        ),
        clampToGround: false,
      },
    });

    // Roof ring of the selected building. The one edge with real weight: a
    // polyline honours its width where a wall outline cannot (see header).
    ds.entities.add({
      polyline: {
        positions: ringAt('selected', true),
        width: 3,
        material: new Cesium.ColorMaterialProperty(MATERIALS.buildingSelectedEdge),
        // The mass underneath is opaque, so an un-depth-tested ring would show
        // through the building from the far side and read as a box, not a roof.
        clampToGround: false,
      },
    });

    // Corners + base ring of the selected building. Hairline by necessity.
    ds.entities.add({
      wall: {
        positions: ringAt('selected', false),
        maximumHeights: new Cesium.CallbackProperty(() => {
          const s = stateRef.current;
          const b = s.selected;
          if (!b || !s.visible || s.hideSelected) return [-1e6, -1e6];
          return new Array(b.flat.length / 2).fill(b.top);
        }, false),
        minimumHeights: new Cesium.CallbackProperty(() => {
          const s = stateRef.current;
          const b = s.selected;
          if (!b || !s.visible || s.hideSelected) return [-1e6, -1e6];
          return new Array(b.flat.length / 2).fill(b.base);
        }, false),
        fill: false,
        outline: true,
        outlineColor: MATERIALS.buildingSelectedEdge,
        outlineWidth: 1,
      },
    });

    // Hover: the roof ring only, and quiet. Hover is a question, selection is
    // an answer -- at equal weight, sweeping the mouse over a block would look
    // like repeatedly selecting things.
    ds.entities.add({
      polyline: {
        positions: ringAt('hovered', true),
        width: 2,
        material: new Cesium.ColorMaterialProperty(MATERIALS.buildingHoverEdge),
        clampToGround: false,
      },
    });

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready]);

  // ---- point them at the current selection --------------------------------
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const buildings = useDataStore.getState().buildings as GeoFC<EnrichedBuilding> | null;

    const shapeOf = (id: number | null) => {
      if (id === null || !buildings) return null;
      const f = buildings.features.find((x) => x.properties.id === id);
      if (!f) return null;
      const ring = (f.geometry.coordinates as number[][][])[0];
      if (ring.length < 4) return null;
      const p = f.properties;
      // The same base and top the mass itself is drawn at, read the same way
      // (BuildingsLayer), so the edge cannot sit proud of or sunk into the
      // building it is outlining.
      const base = toSceneZ(p.ground_elev, p.ground_elev, ground.get(p.id));
      const flat: number[] = [];
      for (const [lon, lat] of ring) flat.push(lon, lat);
      // +0.06: just above the roof cap, which is itself 0.05 m above the wall
      // top. Below it the ring z-fights with the cap it is meant to trace.
      return { flat, base, top: base + Math.max(2, p.height_m) + 0.06 };
    };

    const s = stateRef.current;
    s.selected = shapeOf(activeBuildingId);
    // Never outline the building the cursor is over when it is already the
    // selected one: two edges on one building is not twice as clear.
    s.hovered = hoveredBuildingId === activeBuildingId ? null : shapeOf(hoveredBuildingId);
    // Photoreal hides our geometry under Google's mesh; an edge tracing a
    // footprint that no longer matches the visible roofline would be a lie
    // about where the building is.
    s.visible = showBuildings && !underground && buildingStyle !== 'photoreal';
    /**
     * WHEN AN ENVELOPE IS HONEST.
     *
     * There is no such thing as a selected building at CITY scale: selectBuilding
     * moves the store to 'building' mode in the same write, and BuildingsLayer
     * hides the selected mass there because BuildingModelLayer draws the real
     * architectural model in its place. So the envelope's job is to frame that
     * model -- which it can only do while the model still fills the footprint
     * it was built from.
     *
     * It does not, in four cases, and in each of them a static ring would be
     * describing a volume that is not on screen:
     *   - exploded: the storeys have lifted apart and the stack is taller than
     *     the building.
     *   - sliced: a section has cut part of the footprint away.
     *   - floor / unit mode: the building is reduced to one level, and an
     *     envelope round the whole of it would say the opposite.
     *
     * Hover is unaffected by any of this -- a hovered NEIGHBOUR is still an
     * ordinary undisturbed mass in every one of those states.
     */
    s.hideSelected =
      (mode !== 'city' && mode !== 'building') || explodeT > 0 || sliceOn;
    viewer.scene.requestRender();
  }, [
    viewer, ground, activeBuildingId, hoveredBuildingId, mode, explodeT, sliceOn,
    showBuildings, underground, buildingStyle, buildingsEpoch, buildingsLoaded,
  ]);

  return null;
}
