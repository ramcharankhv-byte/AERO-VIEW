'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { UTILITY_COLOR, UTILITY_SELECTED, tubeShape } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { datumShift } from '@/lib/cesium/terrain';
import type { AssetType, UtilityProps } from '@/lib/types';

/**
 * Utility corridors drawn as PolylineVolume tubes at their true depth.
 *
 * Depth handling mirrors the buildings: the database stores absolute Z against
 * a nominal ground datum, and the scene shifts everything onto the sampled
 * terrain surface so a -3.0 m sewer really sits 3 m under the ground you can
 * see, not 3 m under an imaginary 12 m plane.
 */
export default function UtilitiesLayer() {
  const { viewer, ground, ready } = useViewer();
  const utilities = useDataStore((s) => s.utilities);
  const buildings = useDataStore((s) => s.buildings);
  const showUtilities = useViewStore((s) => s.layers.utilities);
  const selectedUtilityId = useViewStore((s) => s.selectedUtilityId);

  const selectedRef = useRef<number | null>(null);
  useEffect(() => {
    selectedRef.current = selectedUtilityId;
  }, [selectedUtilityId]);

  /** Shift from the stored datum onto the terrain surface. */
  const zShift = useMemo(() => datumShift(buildings, ground), [buildings, ground]);

  useEffect(() => {
    if (!viewer || !ready || !utilities || viewer.isDestroyed()) return;

    const ds = new Cesium.CustomDataSource('utilities');
    viewer.dataSources.add(ds);

    for (const feature of utilities.features) {
      const props = feature.properties as UtilityProps;
      const line = feature.geometry.coordinates as number[][];
      if (!Array.isArray(line) || line.length < 2) continue;

      const flat: number[] = [];
      for (const c of line) {
        // Some centrelines come through as 2D; fall back to depth off the datum.
        const z = (c.length > 2 ? c[2] : props.depth_m) + zShift;
        flat.push(c[0], c[1], z);
      }

      const colour = UTILITY_COLOR[props.asset_type as AssetType];
      const entity = ds.entities.add({
        polylineVolume: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
          shape: tubeShape(Math.max(0.2, props.radius_m)),
          cornerType: Cesium.CornerType.ROUNDED,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(
              () => (selectedRef.current === props.id
                ? UTILITY_SELECTED
                : colour.withAlpha(0.9)),
              false,
            ),
          ),
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(entity, { kind: 'utility', id: props.id });
    }

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, utilities, zShift]);

  // Layer visibility is a cheap show/hide, not a rebuild.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === 'utilities') ds.show = showUtilities;
    }
  }, [viewer, showUtilities, utilities]);

  return null;
}
