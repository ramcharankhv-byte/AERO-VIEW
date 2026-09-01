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
 * Unit volumes for the isolated floor.
 *
 * Only rendered once a floor is isolated -- drawing 6,438 unit prisms at city
 * scale would be both illegible and slow, and the brief only calls for them
 * once you are inside a level.
 */

interface UnitState {
  selectedId: number | null;
  isolated: number | null;
  explodeT: number;
}

export default function UnitsLayer() {
  const { viewer, ground, ready } = useViewer();
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const selectedUnitId = useViewStore((s) => s.selectedUnitId);
  const explodeT = useViewStore((s) => s.explodeT);
  const buildings = useDataStore((s) => s.buildings);
  const detail = useEnsureDetail(mode === 'city' ? null : activeBuildingId);

  const stateRef = useRef<UnitState>({ selectedId: null, isolated: null, explodeT: 0 });
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  useEffect(() => {
    stateRef.current.selectedId = selectedUnitId;
    stateRef.current.isolated = isolatedFloor;
    stateRef.current.explodeT = explodeT;
  }, [selectedUnitId, isolatedFloor, explodeT]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (!detail || activeBuildingId === null) return;
    if (isolatedFloor === null) return;         // units only exist inside a level

    const bprops = buildings?.features.find(
      (f) => f.properties.id === activeBuildingId,
    )?.properties;
    if (!bprops) return;

    const terrainH = ground.get(activeBuildingId);
    const floors = [...detail.floors].sort((a, b) => a.level_no - b.level_no);
    const floorIndex = floors.findIndex((f) => f.level_no === isolatedFloor);
    const lift = floorIndex >= 0 && isolatedFloor >= 0
      ? () => liftFor(floorIndex, stateRef.current.explodeT)
      : () => 0;

    const ds = new Cesium.CustomDataSource('units');
    dsRef.current = ds;
    viewer.dataSources.add(ds);

    for (const unit of detail.units) {
      if (unit.level_no !== isolatedFloor) continue;
      const ring = (unit.ring.coordinates as number[][][])[0];
      const flat: number[] = [];
      for (let i = 0; i < ring.length - 1; i++) flat.push(ring[i][0], ring[i][1]);
      if (flat.length < 6) continue;

      const z0 = toSceneZ(unit.z_min, bprops.ground_elev, terrainH);
      const z1 = toSceneZ(unit.z_max, bprops.ground_elev, terrainH);
      const uid = unit.id;

      const entity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: new Cesium.CallbackProperty(() => z0 + lift(), false),
          extrudedHeight: new Cesium.CallbackProperty(() => z1 + lift(), false),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(
              () => (stateRef.current.selectedId === uid
                ? MATERIALS.unitSelected
                : MATERIALS.unitDefault),
              false,
            ),
          ),
          // The selected unit gets a silhouette outline, so it reads as chosen
          // even where it is occluded by neighbouring units.
          outline: true,
          outlineWidth: 2,
          outlineColor: new Cesium.CallbackProperty(
            () => (stateRef.current.selectedId === uid
              ? MATERIALS.unitOutline
              : MATERIALS.unitOutlineIdle),
            false,
          ),
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(entity, { kind: 'unit', id: uid });
    }

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, ground, detail, activeBuildingId, isolatedFloor, buildings]);

  return null;
}
