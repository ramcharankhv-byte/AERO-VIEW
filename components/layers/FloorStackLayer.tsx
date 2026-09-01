'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useEnsureDetail, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { liftFor } from '@/lib/cesium/explode';
import { tagEntity } from '@/lib/cesium/tag';
import { toSceneZ } from '@/lib/cesium/terrain';

/**
 * The active building's floor stack: one translucent slab per level, basements
 * in solid grey.
 *
 * The explode slider and the isolate state are read through CallbackProperty
 * closures rather than by rebuilding entities, so dragging the slider animates
 * at frame rate instead of thrashing the entity collection.
 */

const SLAB_GAP = 0.35;        // visible seam between stacked slabs
const PLATE_THICKNESS = 0.15; // slab height once a level is isolated

interface StackState {
  explodeT: number;
  isolated: number | null;
  visible: boolean;
}

export default function FloorStackLayer() {
  const { viewer, ground, ready } = useViewer();
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const mode = useViewStore((s) => s.mode);
  const explodeT = useViewStore((s) => s.explodeT);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const showFloors = useViewStore((s) => s.layers.floors);
  const buildings = useDataStore((s) => s.buildings);
  const detail = useEnsureDetail(mode === 'city' ? null : activeBuildingId);

  const stateRef = useRef<StackState>({ explodeT: 0, isolated: null, visible: true });
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  useEffect(() => {
    stateRef.current.explodeT = explodeT;
    stateRef.current.isolated = isolatedFloor;
    stateRef.current.visible = showFloors && mode !== 'city';
  }, [explodeT, isolatedFloor, showFloors, mode]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (!detail || mode === 'city' || activeBuildingId === null) return;

    const bprops = buildings?.features.find(
      (f) => f.properties.id === activeBuildingId,
    )?.properties;
    if (!bprops) return;

    const terrainH = ground.get(activeBuildingId);
    const ds = new Cesium.CustomDataSource('floor-stack');
    dsRef.current = ds;
    viewer.dataSources.add(ds);

    const floors = [...detail.floors].sort((a, b) => a.level_no - b.level_no);

    floors.forEach((fl, index) => {
      const ring = (fl.ring.coordinates as number[][][])[0];
      const flat: number[] = [];
      for (let i = 0; i < ring.length - 1; i++) flat.push(ring[i][0], ring[i][1]);
      if (flat.length < 6) return;

      const z0 = toSceneZ(fl.z_min, bprops.ground_elev, terrainH);
      const z1 = toSceneZ(fl.z_max, bprops.ground_elev, terrainH);
      const isBasement = fl.level_no < 0;
      const level = fl.level_no;

      // Basements must not lift with the explode slider: they are below grade
      // and lifting them through the ground reads as a rendering fault.
      const lift = () => (isBasement ? 0 : liftFor(index, stateRef.current.explodeT));

      const entity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: new Cesium.CallbackProperty(() => z0 + lift(), false),
          // When this level is isolated the slab collapses to a thin floor
          // plate. At full thickness it encloses its own unit volumes, which
          // makes them both invisible and unpickable -- the slab wins the depth
          // test and the pick ray. As a plate, the units stand on it as a grid,
          // which is what the FLOOR view is for.
          extrudedHeight: new Cesium.CallbackProperty(() => {
            const isolated = stateRef.current.isolated === level && !isBasement;
            const top = isolated ? z0 + PLATE_THICKNESS : z1 - SLAB_GAP;
            return top + lift();
          }, false),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const s = stateRef.current;
              if (isBasement) return MATERIALS.basementSlab;
              if (s.isolated === level) return MATERIALS.floorActive;
              return MATERIALS.floorSlab;
            }, false),
          ),
          outline: true,
          outlineColor: MATERIALS.floorOutline,
          shadows: Cesium.ShadowMode.DISABLED,
          show: new Cesium.CallbackProperty(() => {
            const s = stateRef.current;
            if (!s.visible) return false;
            // Isolate hides every level but the chosen one.
            if (s.isolated !== null && s.isolated !== level) return false;
            return true;
          }, false),
        },
      });
      tagEntity(entity, { kind: 'floor', id: fl.id, level });
    });

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, ground, detail, activeBuildingId, mode, buildings]);

  return null;
}
