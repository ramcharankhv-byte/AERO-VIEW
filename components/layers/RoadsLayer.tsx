'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import {
  ROAD_CASING, ROAD_CASING_EXTRA_PX, ROAD_COLOR, ROAD_HOVER, ROAD_SELECTED,
  ROAD_SELECTED_EXTRA_PX, ROAD_STYLE,
} from '@/lib/cesium/materials';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import { tagEntity } from '@/lib/cesium/tag';
import type { RoadClass, RoadProps } from '@/lib/types';

/**
 * Street centrelines, draped on the ground.
 *
 * Reads the store, renders. Never writes to it and never moves the camera.
 *
 * TWO POLYLINES PER STREET: a wide dark casing and a narrower light line.
 * One grey value cannot hold contrast against both the dimmed satellite
 * basemap and Google's bright photoreal mesh, and hue is not available. A
 * light stroke over a dark casing is the standard cartographic answer and it
 * reads over any surface. Only the LINE is tagged; the casing is deliberately
 * untagged so it can never become the pick target.
 *
 * PERFORMANCE -- three deliberate constraints, all for the same reason:
 *
 *   1. `width` is a plain number, never a CallbackProperty. Cesium's
 *      PolylineGeometryUpdater treats a non-constant `positions`, `width`,
 *      `arcType`, `granularity`, `clampToGround` or `zIndex` as grounds for
 *      the DYNAMIC updater, which rebuilds the geometry every frame. This is
 *      the same trap BuildingsLayer documents for `shadows`.
 *   2. A CallbackProperty inside the MATERIAL is fine -- it is not one of
 *      those properties -- so hover and selection are expressed purely as
 *      colour, read from a mutable ref.
 *   3. No dashed materials. Every ColorMaterialProperty ground polyline lands
 *      in a single batched GroundPolylinePrimitive; a dash material would
 *      fragment that batch per instance. Class is carried by grey value and
 *      width instead, which is what keeps this at roughly one draw call.
 *
 * That gives 2N entities in ~1 primitive. At 131 streets that is 262
 * entities; the design holds at thousands. If it ever stops holding, the
 * migration is to a hand-built GroundPolylinePrimitive with one
 * GeometryInstance per street and per-instance colour attributes -- and
 * `tagOf` already reads a raw pick object's `id`, so the Picker would need no
 * change at all.
 */

/** Streets below this class are decluttered when the camera pulls back. */
const DECLUTTER_CLASSES: ReadonlySet<RoadClass> = new Set(['service']);
/** Camera height beyond which service lanes are hidden, metres. */
const DECLUTTER_ABOVE_M = 1200;

interface LayerState {
  hoveredId: number | null;
  selectedId: number | null;
}

export default function RoadsLayer() {
  const { viewer, ready } = useViewer();
  const roads = useDataStore((s) => s.roads);
  const showRoads = useViewStore((s) => s.layers.roads);
  const hoveredRoadId = useViewStore((s) => s.hoveredRoadId);
  const selectedRoadId = useViewStore((s) => s.selectedRoadId);

  const stateRef = useRef<LayerState>({ hoveredId: null, selectedId: null });
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  useEffect(() => {
    stateRef.current.hoveredId = hoveredRoadId;
    stateRef.current.selectedId = selectedRoadId;
    if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
  }, [hoveredRoadId, selectedRoadId, viewer]);

  // ---- build entities once -------------------------------------------------
  useEffect(() => {
    if (!viewer || !ready || !roads || viewer.isDestroyed()) return;

    // Ground-clamped polylines need the terrain-classification path. Where it
    // is unavailable the lines would silently draw at height 0 -- i.e. buried
    // under the terrain -- so say so once rather than rendering a lie.
    if (!Cesium.Entity.supportsPolylinesOnTerrain(viewer.scene)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[roads] this GPU cannot classify polylines onto terrain; '
        + 'street centrelines will not be drawn.',
      );
      return;
    }

    const ds = new Cesium.CustomDataSource('roads');
    dsRef.current = ds;
    viewer.dataSources.add(ds);

    const addStreet = (feature: (typeof roads.features)[number]) => {
      const props = feature.properties as RoadProps;
      const cls = props.cls;
      const style = ROAD_STYLE[cls] ?? ROAD_STYLE.residential;
      const base = ROAD_COLOR[cls] ?? ROAD_COLOR.residential;
      const id = props.id;

      // A merged street is frequently disjoint on the ground -- a dual
      // carriageway, or a name that resumes past a junction -- so the geometry
      // is a MultiLineString and each part becomes its own pair of polylines.
      const parts =
        feature.geometry.type === 'MultiLineString'
          ? (feature.geometry.coordinates as number[][][])
          : [feature.geometry.coordinates as number[][]];

      // Service lanes are the bulk of the count and the least informative at
      // city scale. A distanceDisplayCondition is the cheapest possible
      // declutter and, unlike a `show` callback, keeps the static path.
      const declutter = DECLUTTER_CLASSES.has(cls)
        ? new Cesium.DistanceDisplayCondition(0, DECLUTTER_ABOVE_M)
        : undefined;

      for (const line of parts) {
        if (!Array.isArray(line) || line.length < 2) continue;
        const flat: number[] = [];
        for (const c of line) flat.push(c[0], c[1]);
        const positions = Cesium.Cartesian3.fromDegreesArray(flat);

        // Casing first, and lower, so the line always sits on top of it.
        ds.entities.add({
          polyline: {
            positions,
            width: style.width + ROAD_CASING_EXTRA_PX,
            clampToGround: true,
            // BOTH, not TERRAIN: in photoreal mode the globe surface is hidden
            // and the ground the user sees is Google's mesh. A TERRAIN-only
            // classification would drape these onto a surface that is not being
            // drawn. BOTH is also correct with no tiles present, so this needs
            // no photoreal-specific branch. Same reasoning as ParcelsLayer.
            classificationType: Cesium.ClassificationType.BOTH,
            material: new Cesium.ColorMaterialProperty(ROAD_CASING),
            zIndex: 2,
            distanceDisplayCondition: declutter,
          },
        });

        const entity = ds.entities.add({
          polyline: {
            positions,
            width: style.width,
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
            material: new Cesium.ColorMaterialProperty(
              new Cesium.CallbackProperty(() => {
                const s = stateRef.current;
                if (s.selectedId === id) return ROAD_SELECTED;
                if (s.hoveredId === id) return ROAD_HOVER;
                return base;
              }, false),
            ),
            zIndex: 3,
            distanceDisplayCondition: declutter,
          },
        });
        tagEntity(entity, { kind: 'road', id });
      }
    };

    // 131 streets, but each is a MultiLineString whose parts each become a
    // casing and a line -- 406 ground-clamped polylines, every one of which
    // needs a terrain-classification geometry built. Sliced for the same
    // reason as the other layers: this used to run inside the same task as
    // 12,101 other entities.
    const cancelBuild = buildIncrementally({
      items: roads.features,
      step: addStreet,
      firstSlice: 40,
      onSlice: () => {
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
    });

    return () => {
      cancelBuild();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, roads]);

  // ---- the selected street gets one extra, wider entity ---------------------
  // A brighter colour alone is not enough of a change to find a 2 px line by;
  // it has to get thicker. Width cannot be animated without forcing every road
  // onto the dynamic updater, so the selection is a single separate halo
  // created on demand. Zero cost when nothing is selected.
  useEffect(() => {
    if (!viewer || !ready || !roads || viewer.isDestroyed()) return;
    if (selectedRoadId === null) return;
    const feature = roads.features.find((f) => f.properties.id === selectedRoadId);
    if (!feature) return;

    const props = feature.properties as RoadProps;
    const style = ROAD_STYLE[props.cls] ?? ROAD_STYLE.residential;
    const ds = new Cesium.CustomDataSource('road-selection');
    viewer.dataSources.add(ds);

    const parts =
      feature.geometry.type === 'MultiLineString'
        ? (feature.geometry.coordinates as number[][][])
        : [feature.geometry.coordinates as number[][]];

    for (const line of parts) {
      if (!Array.isArray(line) || line.length < 2) continue;
      const flat: number[] = [];
      for (const c of line) flat.push(c[0], c[1]);
      ds.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          width: style.width + ROAD_SELECTED_EXTRA_PX,
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
          material: new Cesium.ColorMaterialProperty(ROAD_SELECTED.withAlpha(0.45)),
          zIndex: 4,
        },
      });
    }
    viewer.scene.requestRender();

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, roads, selectedRoadId]);

  // Layer visibility is a cheap show/hide, not a rebuild.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === 'roads' || ds.name === 'road-selection') ds.show = showRoads;
    }
    viewer.scene.requestRender();
  }, [viewer, showRoads, roads, selectedRoadId]);

  return null;
}
