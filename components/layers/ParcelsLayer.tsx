'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { flatLonLat } from '@/lib/geo';
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
      const flat = flatLonLat(ring);
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
          // Cesium cannot outline a ground-clamped polygon -- it disables the
          // outline and warns. The boundary is drawn as a ground polyline
          // below instead, which is the supported path and is the only one
          // that survives Photoreal mode.
          outline: false,
          // Clamped to terrain so plots drape over the slope rather than
          // slicing through it.
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
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
