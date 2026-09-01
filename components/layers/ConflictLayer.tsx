'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { CONFLICT_COLOR, CONFLICT_COLOR_DIM, tubeShape } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { datumShift } from '@/lib/cesium/terrain';
import type { UtilityProps } from '@/lib/types';

/**
 * Pulsing overlay on utility runs that ST_3DIntersects flagged as passing
 * through a basement.
 *
 * Drawn as a slightly fatter tube sitting over the UtilitiesLayer geometry, so
 * the underlying asset colour stays readable while the conflict is unmissable.
 */
export default function ConflictLayer() {
  const { viewer, ground, ready } = useViewer();
  const utilities = useDataStore((s) => s.utilities);
  const buildings = useDataStore((s) => s.buildings);
  const conflicts = useDataStore((s) => s.conflicts);
  const underground = useViewStore((s) => s.underground);
  const showUtilities = useViewStore((s) => s.layers.utilities);

  const zShift = useMemo(() => datumShift(buildings, ground), [buildings, ground]);

  const conflictedIds = useMemo(
    () => new Set(conflicts.map((c) => c.utility_id)),
    [conflicts],
  );

  useEffect(() => {
    if (!viewer || !ready || !utilities || viewer.isDestroyed()) return;
    if (conflictedIds.size === 0) return;

    const ds = new Cesium.CustomDataSource('conflicts');
    viewer.dataSources.add(ds);

    // One clock-driven pulse shared by every flagged segment.
    const pulse = () => {
      const t = (Date.now() % 1400) / 1400;
      const k = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
      return Cesium.Color.lerp(
        CONFLICT_COLOR_DIM, CONFLICT_COLOR, k, new Cesium.Color(),
      );
    };

    for (const feature of utilities.features) {
      const props = feature.properties as UtilityProps;
      if (!conflictedIds.has(props.id)) continue;
      const line = feature.geometry.coordinates as number[][];
      if (!Array.isArray(line) || line.length < 2) continue;

      const flat: number[] = [];
      for (const c of line) {
        flat.push(c[0], c[1], (c.length > 2 ? c[2] : props.depth_m) + zShift);
      }

      const entity = ds.entities.add({
        polylineVolume: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
          shape: tubeShape(Math.max(0.2, props.radius_m) * 1.55),
          cornerType: Cesium.CornerType.ROUNDED,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(pulse, false),
          ),
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(entity, { kind: 'utility', id: props.id });
    }

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, utilities, conflictedIds, zShift]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === 'conflicts') ds.show = underground && showUtilities;
    }
  }, [viewer, underground, showUtilities, utilities, conflicts]);

  return null;
}
