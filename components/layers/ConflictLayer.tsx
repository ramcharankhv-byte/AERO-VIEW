'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { CONFLICT_COLOR, CONFLICT_COLOR_DIM, tubeShape } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { datumShift } from '@/lib/cesium/terrain';
import { planRunGeometry } from '@/lib/geo';
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
    //
    // Two details matter at frame rate. The lerp writes into a SCRATCH colour
    // rather than allocating -- this runs once per flagged entity per frame,
    // and `new Cesium.Color()` inside it made the pulse a steady source of
    // garbage. And the phase is computed once per frame, not once per entity:
    // every segment must pulse in step anyway, so re-deriving it per entity was
    // both wasted work and a way for two segments either side of a millisecond
    // boundary to disagree.
    const scratch = new Cesium.Color();
    let phaseFrame = -1;
    let phase = 0;
    const pulse = () => {
      const now = Date.now();
      if (now !== phaseFrame) {
        phaseFrame = now;
        const t = (now % 1400) / 1400;
        phase = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
      }
      return Cesium.Color.lerp(CONFLICT_COLOR_DIM, CONFLICT_COLOR, phase, scratch);
    };

    for (const feature of utilities.features) {
      const props = feature.properties as UtilityProps;
      if (!conflictedIds.has(props.id)) continue;
      const line = feature.geometry.coordinates as number[][];
      if (!Array.isArray(line) || line.length < 2) continue;

      // Same vertical-run split the base layer does: a conflicted riser would
      // otherwise throw on normalise and take the whole batch with it. See
      // planRunGeometry.
      const { tube, risers } = planRunGeometry(
        line,
        (c) => (c.length > 2 ? c[2] : props.depth_m) + zShift,
      );
      const radius = Math.max(0.2, props.radius_m) * 1.55;
      const material = new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(pulse, false),
      );

      if (tube.length >= 6) {
        const entity = ds.entities.add({
          polylineVolume: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(tube),
            shape: tubeShape(radius),
            cornerType: Cesium.CornerType.ROUNDED,
            material,
            shadows: Cesium.ShadowMode.DISABLED,
          },
        });
        tagEntity(entity, { kind: 'utility', id: props.id });
      }
      for (const r of risers) {
        const entity = ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, (r.z0 + r.z1) / 2),
          cylinder: {
            length: r.z1 - r.z0,
            topRadius: radius,
            bottomRadius: radius,
            material,
            shadows: Cesium.ShadowMode.DISABLED,
          },
        });
        tagEntity(entity, { kind: 'utility', id: props.id });
      }
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
