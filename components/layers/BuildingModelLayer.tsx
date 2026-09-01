'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { toSceneZ } from '@/lib/cesium/terrain';
import { flatLonLat } from '@/lib/geo';
import { buildRoof } from '@/lib/cesium/roofs';
import { fixturesFor } from '@/lib/cesium/equipment';
import { windowGrid } from '@/lib/cesium/textures';
import type { BuildingProps, UseType } from '@/lib/types';

/**
 * The architectural model of the active building.
 *
 * Replaces the simple extruded prism with:
 *   - a wall extrusion carrying a per-use-type window-grid texture,
 *   - a use-type-appropriate roof (gabled / flat+parapet / hipped / sawtooth),
 *   - rooftop fixtures (water tank, AC units, flagpole, cowls).
 *
 * Only one building is ever modelled. On deselect, the layer tears itself
 * down and the city view reverts to the 384 prisms drawn by BuildingsLayer.
 * BuildingsLayer's `hideActive` already hides the active prism while a model
 * is up, so the two layers never overlap on screen.
 */

export default function BuildingModelLayer() {
  const { viewer, ground, ready } = useViewer();
  const buildings = useDataStore((s) => s.buildings);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const mode = useViewStore((s) => s.mode);

  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (!buildings || activeBuildingId === null || mode === 'city') {
      // Deselect: tear down if we still have a model up.
      if (dsRef.current && !viewer.isDestroyed()) {
        viewer.dataSources.remove(dsRef.current, true);
        dsRef.current = null;
      }
      return;
    }

    const feat = buildings.features.find(
      (f) => f.properties.id === activeBuildingId,
    );
    if (!feat) return;
    const props = feat.properties as BuildingProps & { footprint?: { coordinates: number[][][] } };
    const ring = (feat.geometry.coordinates as number[][][])[0];
    if (ring.length < 4) return;

    const use = props.use_type as UseType;
    const flat = flatLonLat(ring);
    if (flat.length < 6) return;

    const terrainH = ground.get(activeBuildingId);
    const base = toSceneZ(props.ground_elev, props.ground_elev, terrainH);
    const top = base + Math.max(2, props.height_m);

    // Build a fresh data source so previous selections are fully released.
    const ds = new Cesium.CustomDataSource('building-model');
    viewer.dataSources.add(ds);
    dsRef.current = ds;

    // ---- walls: a single extruded polygon with a window-grid texture ----
    const wallCanvas = windowGrid(use);
    const wallTexture = new Cesium.ImageMaterialProperty({
      image: wallCanvas,
      color: Cesium.Color.WHITE,
    });
    ds.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
        height: base,
        extrudedHeight: top,
        material: wallTexture,
        outline: true,
        outlineColor: MATERIALS.buildingModelRoof(use),
        shadows: Cesium.ShadowMode.DISABLED,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });

    // ---- roof: one or more polygons above the wall top ------------------
    const roof = buildRoof(use, ring, base, props.height_m);
    const roofColor = new Cesium.ColorMaterialProperty(MATERIALS.buildingModelRoof(use));
    for (const face of roof.faces) {
      ds.entities.add({
        polygon: {
          hierarchy: face,
          // Roof sits a hair above the wall so it does not z-fight the cap.
          height: roof.baseZ + 0.01,
          material: roofColor,
          outline: true,
          outlineColor: MATERIALS.buildingModelFixture,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
    }

    // ---- floor bands: a horizontal line at every floor level -----------
    // One tile of the window texture is 3.2 m tall (one storey), so a line
    // at every 3.2 m reads as a floor division on the wall. The lines wrap
    // the whole ring; on a closed polygon they sit exactly on the wall
    // surface, so no z-fighting against the textured extrusion.
    const FLOOR_H = 3.2;
    const bandPositionsCache: number[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      bandPositionsCache.push(flat[i], flat[i + 1]);
    }
    const bandMat = new Cesium.ColorMaterialProperty(MATERIALS.buildingModelFixture);
    // A band for every level including the floor above the top (a cornice)
    // and the floor below ground (the ground line).
    for (let lvl = -props.basements; lvl <= props.floors; lvl++) {
      const z = base + lvl * FLOOR_H;
      if (z < base - 0.05 || z > top + 0.05) continue;
      const isCornice = lvl === props.floors;
      const positions: number[] = [];
      for (let i = 0; i < bandPositionsCache.length; i += 2) {
        positions.push(bandPositionsCache[i], bandPositionsCache[i + 1], z);
      }
      ds.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
          width: isCornice ? 2 : 1.2,
          material: bandMat,
          clampToGround: false,
        },
      });
    }

    // ---- a slim cornice strip just under the roof so the parapet reads
    // Ring centroid + per-vertex inset (0.3 m shrink).
    const { lon: cLon, lat: cLat } = (() => {
      const n = Math.max(1, ring.length - 1);
      let x = 0, y = 0;
      for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
      return { lon: x / n, lat: y / n };
    })();
    const mPerDegLat = 110574;
    const mPerDegLon = 111320 * Math.cos((cLat * Math.PI) / 180);
    const inset: number[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const lon = ring[i][0];
      const lat = ring[i][1];
      const dx = (lon - cLon) * mPerDegLon;
      const dy = (lat - cLat) * mPerDegLat;
      const d = Math.hypot(dx, dy);
      if (d < 0.4) {
        inset.push(lon, lat);
      } else {
        inset.push(
          cLon + ((lon - cLon) * (d - 0.3)) / d,
          cLat + ((lat - cLat) * (d - 0.3)) / d,
        );
      }
    }
    // Cornice band: a thin extrusion at the top of the wall, 0.4 m thick.
    ds.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(inset),
        ),
        height: top - 0.4,
        extrudedHeight: top,
        material: bandMat,
        outline: false,
        shadows: Cesium.ShadowMode.DISABLED,
      },
    });

    // ---- parapet: a short wall that closes the top of the building -----
    // 1 m high ring at the slightly inset perimeter, sitting on the cornice.
    ds.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(inset),
        ),
        height: top,
        extrudedHeight: top + 1.0,
        material: bandMat,
        outline: false,
        shadows: Cesium.ShadowMode.DISABLED,
      },
    });
    void mPerDegLat;

    // ---- fixtures: cylinders, boxes on the roof ------------------------
    const fixtures = fixturesFor(use, ring, base, props.height_m);
    for (const f of fixtures) ds.entities.add(f);

    // ---- selection highlight: a polyline along the top of the wall ----
    // Stays visible even when the floor stack is occluding the walls.
    const topFlat: number[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      topFlat.push(flat[i], flat[i + 1], top + 0.05);
    }
    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(topFlat),
        width: 2,
        material: MATERIALS.unitOutline,
        clampToGround: false,
      },
    });

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, ground, buildings, activeBuildingId, mode]);

  return null;
}
