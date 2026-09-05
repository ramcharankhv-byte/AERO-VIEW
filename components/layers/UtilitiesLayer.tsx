'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { UTILITY_COLOR, UTILITY_SELECTED, tubeShape } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import { datumShift } from '@/lib/cesium/terrain';
import { planRunGeometry } from '@/lib/geo';
import type { AssetType, UtilityProps } from '@/lib/types';

/**
 * Utility corridors drawn as PolylineVolume tubes at their true depth.
 *
 * Depth handling mirrors the buildings: the database stores absolute Z against
 * a nominal ground datum, and the scene shifts everything onto the sampled
 * terrain surface so a -3.0 m sewer really sits 3 m under the ground you can
 * see, not 3 m under an imaginary 12 m plane.
 *
 * PERFORMANCE. There are 1,515 runs. Each one used to carry a CallbackProperty
 * material asking, every rendered frame, whether it was the selected utility --
 * 1,514 of which answered no, every frame, forever. Selection is now a single
 * highlight entity created on demand (the idiom RoadsLayer established for the
 * selected street) and every tube in the base layer is a constant colour, so
 * the layer costs nothing per frame once it is built.
 *
 * The tubes also carry a distance condition. A buried service at 3 m depth is
 * sub-pixel from the city overview, and PolylineVolume geometry is the most
 * expensive thing this app draws per metre of line.
 */

/** Camera distance beyond which buried runs stop being drawn, metres. */
const VISIBLE_WITHIN_M = 3000;
export default function UtilitiesLayer() {
  const { viewer, ground, ready } = useViewer();
  const utilities = useDataStore((s) => s.utilities);
  const buildings = useDataStore((s) => s.buildings);
  const showUtilities = useViewStore((s) => s.layers.utilities);
  const selectedUtilityId = useViewStore((s) => s.selectedUtilityId);

  /** Shift from the stored datum onto the terrain surface. */
  const zShift = useMemo(() => datumShift(buildings, ground), [buildings, ground]);

  useEffect(() => {
    if (!viewer || !ready || !utilities || viewer.isDestroyed()) return;

    const ds = new Cesium.CustomDataSource('utilities');
    viewer.dataSources.add(ds);

    const visibility = new Cesium.DistanceDisplayCondition(0, VISIBLE_WITHIN_M);

    const addRun = (feature: (typeof utilities.features)[number]) => {
      const props = feature.properties as UtilityProps;
      const line = feature.geometry.coordinates as number[][];
      if (!Array.isArray(line) || line.length < 2) return;

      // Some centrelines come through as 2D; fall back to depth off the datum.
      const { tube, risers } = planRunGeometry(
        line,
        (c) => (c.length > 2 ? c[2] : props.depth_m) + zShift,
      );

      const colour = UTILITY_COLOR[props.asset_type as AssetType];
      const radius = Math.max(0.2, props.radius_m);
      const material = new Cesium.ColorMaterialProperty(colour.withAlpha(0.9));

      if (tube.length >= 6) {
        const entity = ds.entities.add({
          polylineVolume: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(tube),
            shape: tubeShape(radius),
            cornerType: Cesium.CornerType.ROUNDED,
            material,
            shadows: Cesium.ShadowMode.DISABLED,
            distanceDisplayCondition: visibility,
          },
        });
        tagEntity(entity, { kind: 'utility', id: props.id });
      }

      // Vertical sections: a riser up a building, a drop into a trench. A
      // swept volume cannot express these (see planRunGeometry), so each is a
      // cylinder of the same radius, tagged with the same id -- clicking a
      // riser selects the run it belongs to, exactly as clicking its tube does.
      for (const r of risers) {
        const entity = ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, (r.z0 + r.z1) / 2),
          cylinder: {
            length: r.z1 - r.z0,
            topRadius: radius,
            bottomRadius: radius,
            material,
            shadows: Cesium.ShadowMode.DISABLED,
            distanceDisplayCondition: visibility,
          },
        });
        tagEntity(entity, { kind: 'utility', id: props.id });
      }
    };

    // PolylineVolume is the heaviest geometry here: a swept tube with rounded
    // corners per run. Slicing keeps 1,515 of them off the boot critical path.
    const cancelBuild = buildIncrementally({
      items: utilities.features,
      step: addRun,
      firstSlice: 120,
      onSlice: () => {
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
    });

    return () => {
      cancelBuild();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, utilities, zShift]);

  /**
   * The selected run, redrawn once as its own entity in the selection colour.
   *
   * Sits exactly on the base tube rather than replacing it: at the same radius
   * and the same positions the two are coincident, so the selection colour is
   * simply what you see. Removed on deselect.
   */
  useEffect(() => {
    if (!viewer || !ready || !utilities || viewer.isDestroyed()) return;
    if (selectedUtilityId === null) return;
    const feature = utilities.features.find(
      (f) => (f.properties as UtilityProps).id === selectedUtilityId,
    );
    if (!feature) return;
    const props = feature.properties as UtilityProps;
    const line = feature.geometry.coordinates as number[][];
    if (!Array.isArray(line) || line.length < 2) return;

    const { tube, risers } = planRunGeometry(
      line,
      (c) => (c.length > 2 ? c[2] : props.depth_m) + zShift,
    );

    const ds = new Cesium.CustomDataSource('utility-selection');
    viewer.dataSources.add(ds);
    // A hair fatter than the base geometry so it cannot z-fight with it.
    const radius = Math.max(0.2, props.radius_m) * 1.06;
    const material = new Cesium.ColorMaterialProperty(UTILITY_SELECTED);

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
      // Tagged like the base run, so clicking the highlight keeps the selection
      // rather than reading as a click on bare ground.
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
    viewer.scene.requestRender();

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, utilities, zShift, selectedUtilityId]);

  // Layer visibility is a cheap show/hide, not a rebuild.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === 'utilities' || ds.name === 'utility-selection') {
        ds.show = showUtilities;
      }
    }
  }, [viewer, showUtilities, utilities, selectedUtilityId]);

  return null;
}
