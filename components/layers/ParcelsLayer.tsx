'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import type { ParcelInfo } from '@/lib/types';

/**
 * Surface parcel polygons, clamped to the terrain.
 *
 * These boundaries are DERIVED, not surveyed: they are Voronoi plots around
 * clustered OSM footprints (see scripts/build_geometry.sql). The DetailPanel
 * says so on every parcel, because presenting a computed curtilage as a legal
 * boundary would be exactly the confusion this system exists to prevent.
 */
export default function ParcelsLayer() {
  const { viewer, ready } = useViewer();
  const parcels = useDataStore((s) => s.parcels);
  const buildings = useDataStore((s) => s.buildings);
  const showParcels = useViewStore((s) => s.layers.parcels);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);

  const activeParcelRef = useRef<number | null>(null);
  useEffect(() => {
    const props = buildings?.features.find(
      (f) => f.properties.id === activeBuildingId,
    )?.properties;
    activeParcelRef.current = props ? props.parcel_id : null;
  }, [activeBuildingId, buildings]);

  useEffect(() => {
    if (!viewer || !ready || !parcels || viewer.isDestroyed()) return;

    const ds = new Cesium.CustomDataSource('parcels');
    viewer.dataSources.add(ds);

    for (const feature of parcels.features) {
      const props = feature.properties as ParcelInfo;
      const ring = (feature.geometry.coordinates as number[][][])[0];
      const flat: number[] = [];
      for (let i = 0; i < ring.length - 1; i++) flat.push(ring[i][0], ring[i][1]);
      if (flat.length < 6) continue;

      const pid = props.id;
      const entity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(
              () => (activeParcelRef.current === pid
                ? MATERIALS.parcelActive
                : MATERIALS.parcelFill),
              false,
            ),
          ),
          outline: true,
          outlineColor: MATERIALS.parcelOutline,
          // Clamped to terrain so plots drape over the slope rather than
          // slicing through it.
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          classificationType: Cesium.ClassificationType.TERRAIN,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(entity, { kind: 'parcel', id: pid });
    }

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, parcels]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.name === 'parcels') ds.show = showParcels;
    }
  }, [viewer, showParcels, parcels]);

  return null;
}
