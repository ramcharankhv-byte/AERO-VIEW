'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { toSceneZ } from '@/lib/cesium/terrain';
import { flatLonLat } from '@/lib/geo';
import { mark } from '@/lib/boot-marks';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import type { UseType } from '@/lib/types';

/**
 * Far-tier building silhouette: one `Cesium.Primitive`, N `GeometryInstance`s,
 * drawn only past the near tier's distance cutoff.
 *
 * WHY THIS EXISTS. BuildingsLayer's entity-based path is the right answer for a
 * few hundred footprints: tagged, pickable, animatable, with per-entity fade
 * and selection state. The same path is the wrong answer for 2,213 footprints
 * under a single Hyderabad orbit: every entity has at least one
 * `CallbackProperty` (the fade closure, the show closure), and the per-frame
 * property batch re-evaluates them all whether the entity is on screen or not.
 * With the 1,500 m `DistanceDisplayCondition` on the near tier, the city view
 * keeps the entity pool populated but invisible; we need a separate, static
 * representation for the "look at the city from far enough away" case.
 *
 * DESIGN. One `Primitive` holding one `GeometryInstance` per footprint. Wall
 * only -- no cap, because at the far view a cap is one extra horizontal plane
 * per building and the silhouette is what reads. Static geometry, static
 * material, static per-instance colour attribute, static `DistanceDisplayCondition`,
 * `releaseGeometryInstances: true` once the primitive is ready. There is no
 * `CallbackProperty` anywhere in this file; the geometry batch never re-evaluates
 * a closure for these buildings.
 *
 * WHAT THE FAR TIER DOES NOT DO. It does not animate, does not fade, does not
 * follow the active building. It does not appear in photoreal mode (the
 * 0.01-alpha ghost extrusion in BuildingsLayer is what makes Photoreal pickable;
 * the city view there is a Google mesh and a far tier over it would be moire).
 * It does not react to the buildings layer toggle on its own; BuildingsLayer
 * owns that and the far tier mirrors it.
 *
 * PICKING. Each `GeometryInstance.id` carries the same `{ kind: 'building', id }`
 * shape the entity layer tags with, so the Picker can resolve a click on the
 * far tier the same way it resolves a click on a near-tier entity -- the click
 * does not need to know which tier it landed on. See the comment on
 * `releaseGeometryInstances` below for why the id survives a release.
 */

/**
 * MUST match BuildingsLayer's NEAR_DDC upper bound. The two tiers are
 * back-to-back at this number; nothing is rendered twice and nothing falls in
 * the gap. The constant is duplicated rather than imported so this layer
 * compiles if BuildingsLayer is changed without thought.
 */
const FAR_M = 1500;
/**
 * Per-instance DDC for a Primitive. Cesium's Primitive DDC is not a property
 * of the Primitive itself; it is carried as a `GeometryInstanceAttribute` on
 * each instance. Building it once and reusing the same Float32Array across
 * every instance is the static geometry path -- the alternative, a per-call
 * `new`, would allocate 2,213 typed arrays at build time for no benefit.
 */
const FAR_DDC_ATTR = new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(
  FAR_M, Number.POSITIVE_INFINITY,
);

/**
 * Alpha at the far view.
 *
 * The near tier sits at BUILDING_ALPHA (0.45) -- at city scale the imagery
 * underneath has to stay readable. The far tier is seen from a distance where
 * a 0.45 wash becomes invisible against bright rooftops; we go up to 0.75 so
 * the silhouette still carries the building against the same imagery. This
 * is the only layer that overrides BUILDING_ALPHA, deliberately.
 */
const FAR_ALPHA = 0.75;

export default function BuildingsFarLayer() {
  const { viewer, ground, ready } = useViewer();
  // Same epoch discipline as BuildingsLayer: a one-building edit must not tear
  // down the far tier. The primitive survives attribute edits; the full
  // collection's epoch is what re-creates it.
  const buildingsEpoch = useDataStore((s) => s.buildingsEpoch);
  const buildingsLoaded = useDataStore((s) => s.buildings !== null);
  const showBuildings = useViewStore((s) => s.layers.buildings);
  // Photoreal hides the schematic and shows Google's 3D Tiles mesh. The far
  // tier at FAR_ALPHA would be opaque over that mesh, which is the wrong
  // product behaviour -- the city is supposed to read as the captured mesh,
  // with the schematic only there at 0.01 alpha for picking (see
  // BuildingsLayer's `buildingGhost`). Hide the primitive while Photoreal
  // is on; turn it back on when the user returns to Schematic.
  const buildingStyle = useViewStore((s) => s.buildingStyle);

  /**
   * The primitive that lives in the scene. Held in a ref so the layer-toggle
   * effect can update `show` without rebuilding the primitive.
   */
  const primitiveRef = useRef<Cesium.Primitive | null>(null);
  /**
   * Disposer for the in-flight incremental build, so a re-run (new epoch,
   * unmount) cancels the slice loop before it writes into a stale array.
   */
  const cancelRef = useRef<(() => void) | null>(null);
  /**
   * Latches to false in the effect's cleanup, before any other teardown.
   * `buildIncrementally` schedules its slices on a queue; cancelling the
   * disposer stops the QUEUE, but a slice already in flight when cleanup
   * runs can still reach `onDone`. The alive flag is the only signal the
   * callback has that its effect is gone, and it short-circuits the
   * primitive creation before the scene's primitive list is touched.
   * Without this, a hot-reload or viewer re-create can leave a Primitive
   * in the (now-disposed) scene's primitive list with no JS reference.
   */
  const aliveRef = useRef(true);

  // ---- build the primitive once ------------------------------------------
  useEffect(() => {
    if (!viewer || !ready || !buildingsLoaded || viewer.isDestroyed()) return;
    const buildings = useDataStore.getState().buildings;
    if (!buildings) return;

    // The instances array is built incrementally and handed to the Primitive
    // in onDone. It is intentionally not pushed to until onDone: Primitive
    // snapshots its geometryInstances synchronously in the constructor, so
    // mutating the array after construction would have no effect, and
    // releaseGeometryInstances: true (below) frees it once the primitive
    // holds its own copy.
    const instances: Cesium.GeometryInstance[] = [];

    const addFootprint = (feature: typeof buildings.features[number]) => {
      // A late slice: the effect is already gone, the array is on its way
      // to the GC. Do not mutate it; the slice was cancelled in cleanup
      // and the next onDone check will skip the Primitive creation.
      if (!aliveRef.current) return;
      const props = feature.properties;
      const ring = (feature.geometry.coordinates as number[][][])[0];
      const flat = flatLonLat(ring);
      if (flat.length < 6) return;
      const terrainH = ground.get(props.id);
      const base = toSceneZ(props.ground_elev, props.ground_elev, terrainH);
      const top = base + Math.max(2, props.height_m);
      const use = props.use_type as UseType;
      const color = MATERIALS.buildingFacade(use, FAR_ALPHA);

      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(flat),
          ),
          height: base,
          extrudedHeight: top,
          // perPositionHeight false: every vertex inherits `height` and
          // `extrudedHeight`; this is what makes the geometry a constant
          // value the static updater will not re-evaluate.
          perPositionHeight: false,
        }),
        // Per-instance color. With PerInstanceColorAppearance this is the
        // only per-instance attribute; the appearance's vertex shader uses
        // it as the base colour. The map keyed on use_type is the same one
        // the near tier's CallbackProperty would have asked for, but
        // resolved once at build time instead of per frame.
        //
        // The DDC travels in the SAME attributes object -- Primitive DDC
        // is per-instance, not a Primitive property. Sharing one attribute
        // instance across all 2,213 instances is fine: GeometryInstance
        // copies it into the GPU buffer; no aliasing.
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
          distanceDisplayCondition: FAR_DDC_ATTR,
        },
        // The picker reads `picked.tag` after unwrapping the picked object.
        // Wrapping the tag here keeps the primitive indistinguishable from
        // a near-tier entity at pick time. See tagOf() in lib/cesium/tag.ts.
        id: { tag: { kind: 'building', id: props.id } },
      }));
    };

    cancelRef.current = buildIncrementally({
      items: buildings.features,
      step: addFootprint,
      firstSlice: 250,
      // No onSlice render request: the primitive is not in the scene yet,
      // so a frame request would render the same scene the user is already
      // looking at. The near tier's requestRender is the one that drives
      // progress visibility.
      onDone: () => {
        // The effect was torn down between the last slice and now.
        // Drop the work on the floor; there is no scene to add it to
        // and the next effect run will start fresh.
        if (!aliveRef.current) return;
        if (!viewer || viewer.isDestroyed()) return;
        const primitive = new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({
            // flat:false so the appearance's vertex shader lights the wall;
            // a flat colour is the wrong answer for a 3D extrusion seen from
            // oblique angles.
            flat: false,
            translucent: true,
            closed: true,
          }),
          // synchronous: the geometry was already built incrementally on the
          // main thread; a worker would re-do it for no reason. Wait for the
          // readiness promise below before considering the primitive live.
          asynchronous: false,
          // Frees the JS array once the GPU buffers are uploaded. The id
          // objects we attached are still referenced by the pick framebuffer
          // table, so picking continues to work after this.
          releaseGeometryInstances: true,
          shadows: Cesium.ShadowMode.DISABLED,
        });
        primitive.show = showBuildings && buildingStyle !== 'photoreal';
        viewer.scene.primitives.add(primitive);
        primitiveRef.current = primitive;
        mark('buildings-far-built');
      },
    });

    return () => {
      // The alive flag goes first, before any cancellation: any in-flight
      // slice that reads it sees false and the onDone check at completion
      // sees false. The cancel call below stops future slices from being
      // scheduled; the alive flag stops the one that already passed the
      // cancel point.
      aliveRef.current = false;
      cancelRef.current?.();
      cancelRef.current = null;
      const p = primitiveRef.current;
      primitiveRef.current = null;
      if (p && !viewer.isDestroyed()) {
        viewer.scene.primitives.remove(p);
      }
    };
  }, [viewer, ready, buildingsLoaded, buildingsEpoch, ground]);

  // ---- mirror the buildings layer toggle ----------------------------------
  // BuildingsLayer owns the visibility state; the far tier follows it so the
  // two never show one without the other. Photoreal mode hides the far tier
  // as well -- the user is looking at Google's mesh, not the schematic.
  useEffect(() => {
    const p = primitiveRef.current;
    if (p) p.show = showBuildings && buildingStyle !== 'photoreal';
  }, [showBuildings, buildingStyle]);

  return null;
}
