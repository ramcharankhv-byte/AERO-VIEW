'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { plotHatch } from '@/lib/cesium/textures';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import { createBucketGrid, extentOf } from '@/lib/cesium/spatial-buckets';
import { flatLonLat, orientedDims } from '@/lib/geo';
import type { ParcelInfo } from '@/lib/types';

/**
 * Surface parcel polygons, clamped to the terrain.
 *
 * These boundaries are DERIVED, not surveyed: they are Voronoi plots around
 * clustered OSM footprints (see scripts/build_geometry.sql). The DetailPanel
 * says so on every parcel, because presenting a computed curtilage as a legal
 * boundary would be exactly the confusion this system exists to prevent.
 *
 * PERFORMANCE. This is the largest layer by entity count -- 1,634 parcels x
 * three entities each -- so two things it used to do have been taken out:
 *
 *   1. The fill carried a CallbackProperty that asked, on every rendered
 *      frame, for every parcel, "am I the active one?". At most ONE parcel is
 *      ever active, so that was 1,633 callbacks per frame all computing false.
 *      The fill is a constant colour now and the highlight is a single extra
 *      entity created on demand -- the idiom RoadsLayer already uses for the
 *      selected street, adopted here for the same reason.
 *   2. The hatch overlay reads as cadastral subdivision when you are close
 *      enough to see a plot. From 1.2 km up it is a grey wash spread over
 *      1,634 ground-classified polygons. It now carries a distance condition,
 *      which is a CONSTANT property and so keeps the static geometry path.
 */

/** Camera distance beyond which the plot hatch stops being drawn, metres. */
const HATCH_VISIBLE_WITHIN_M = 1400;
export default function ParcelsLayer() {
  const { viewer, ready } = useViewer();
  const parcels = useDataStore((s) => s.parcels);
  const buildings = useDataStore((s) => s.buildings);
  const showParcels = useViewStore((s) => s.layers.parcels);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);

  /** The parcel under the active building, or null. */
  const activeParcelId = useMemo(() => {
    if (!buildings || activeBuildingId === null) return null;
    const b = buildings.features.find((f) => f.properties.id === activeBuildingId);
    return b ? b.properties.parcel_id : null;
  }, [activeBuildingId, buildings]);

  useEffect(() => {
    if (!viewer || !ready || !parcels || viewer.isDestroyed()) return;

    const grid = createBucketGrid(
      viewer,
      'parcels',
      extentOf(parcels.features.map((f) => {
        const ring = (f.geometry.coordinates as number[][][])[0];
        return [ring[0][0], ring[0][1]] as const;
      })),
    );

    const hatchCondition = new Cesium.DistanceDisplayCondition(
      0, HATCH_VISIBLE_WITHIN_M,
    );

    const addParcel = (feature: (typeof parcels.features)[number]) => {
      const props = feature.properties as ParcelInfo;
      const ring = (feature.geometry.coordinates as number[][][])[0];
      const flat = flatLonLat(ring);
      if (flat.length < 6) return;

      const pid = props.id;
      const ds = grid.forPoint(ring[0][0], ring[0][1]);
      const entity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          // Constant, so this polygon stays out of Cesium per-frame attribute
          // work entirely. The active parcel is drawn by the highlight effect
          // below instead of being asked for on every frame here.
          material: new Cesium.ColorMaterialProperty(MATERIALS.parcelFill),
          // Cesium cannot outline a ground-clamped polygon -- it disables the
          // outline and warns. The boundary is drawn as a ground polyline
          // below instead, which is the supported path and is the only one
          // that survives Photoreal mode.
          outline: false,
          // No `height`: an undefined height is what drapes the polygon on the
          // ground (the GroundPrimitive path). heightReference must NOT be set
          // here -- Cesium ignores it without a defined height and logs a
          // warning every frame.
          // BOTH, not TERRAIN: in Photoreal mode the globe surface is hidden
          // and the ground the user sees is Google's 3D Tiles mesh. A
          // TERRAIN-only classification would drape these boundaries onto a
          // surface that is not being drawn, and the parcel edges would vanish
          // under the tiles. BOTH is also correct with no tiles present, so
          // this needs no photoreal-specific branch.
          classificationType: Cesium.ClassificationType.BOTH,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(entity, { kind: 'parcel', id: pid });

      // The visible boundary. A ground polyline is draped by the renderer onto
      // whatever surface is actually being drawn, so the same entity reads
      // correctly over terrain and over Google's mesh -- which a 16%-alpha
      // fill does not: against dense captured imagery it disappears entirely.
      ds.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          width: 2,
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
          material: new Cesium.ColorMaterialProperty(MATERIALS.parcelOutline),
        },
      });

      // Plot texture: a hatched subdivision fill inside the plot so the flat
      // map reads as cadastre rather than as translucent paint. Repeats the
      // small hatch canvas across the polygon.
      const dims = orientedDims(ring);
      const hatch = plotHatch(pid, dims.longAxisDeg);
      ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          material: new Cesium.ImageMaterialProperty({
            image: hatch,
            transparent: true,
          }),
          classificationType: Cesium.ClassificationType.BOTH,
          outline: false,
          shadows: Cesium.ShadowMode.DISABLED,
          distanceDisplayCondition: hatchCondition,
        },
      });
    };

    const cancelBuild = buildIncrementally({
      items: parcels.features,
      step: addParcel,
      firstSlice: 200,
      // The viewer runs in requestRenderMode: without asking for a frame the
      // slices would all become visible at once, when something else happened
      // to trigger a render, which defeats the point of slicing them.
      onSlice: () => {
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
    });

    return () => {
      cancelBuild();
      grid.dispose();
    };
  }, [viewer, ready, parcels]);

  /**
   * The active parcel highlight: one entity, created when there is one to show
   * and destroyed when there is not.
   *
   * Zero cost when nothing is selected, which is the state the scene is in for
   * most of its life -- and, unlike the callback it replaces, zero cost per
   * frame for the 1,633 parcels that are not selected either.
   */
  useEffect(() => {
    if (!viewer || !ready || !parcels || viewer.isDestroyed()) return;
    if (activeParcelId === null) return;
    const feature = parcels.features.find(
      (f) => (f.properties as ParcelInfo).id === activeParcelId,
    );
    if (!feature) return;
    const flat = flatLonLat((feature.geometry.coordinates as number[][][])[0]);
    if (flat.length < 6) return;

    const ds = new Cesium.CustomDataSource('parcel-active');
    viewer.dataSources.add(ds);
    ds.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
        material: new Cesium.ColorMaterialProperty(MATERIALS.parcelActive),
        classificationType: Cesium.ClassificationType.BOTH,
        outline: false,
        shadows: Cesium.ShadowMode.DISABLED,
      },
    });
    viewer.scene.requestRender();

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, parcels, activeParcelId]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      // startsWith, not equality: the base layer is a grid of buckets named
      // parcels#0 .. parcels#15 (lib/cesium/spatial-buckets.ts).
      if (ds.name.startsWith('parcels') || ds.name === 'parcel-active') {
        ds.show = showParcels;
      }
    }
  }, [viewer, showParcels, parcels, activeParcelId]);

  return null;
}
