'use client';

/**
 * One-time Cesium viewer setup. The functions here run in a specific order in
 * CesiumRoot's mount effect; they are split out so that effect body reads as
 * a short sequence rather than a 130-line monolith.
 */
import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useState } from 'react';
import { ringCentroid } from '@/lib/geo';
import { applyGisDarkScene } from './imagery';
import { SCENE_BACKGROUND } from './materials';
import { sampleGroundHeights, type GroundMap, type SamplePoint } from './terrain';
import type { BuildingProps, ConflictRow, GeoFC, ParcelInfo, UtilityProps } from '@/lib/types';

export const AOI = {
  west: 83.313,
  south: 17.718,
  east: 83.3245,
  north: 17.728,
};

/** True iff NEXT_PUBLIC_CESIUM_TOKEN is set. */
export function hasIonToken(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CESIUM_TOKEN?.trim());
}

/** World Terrain when a token is present, ellipsoid otherwise. */
export async function createTerrain(hasIon: boolean): Promise<Cesium.TerrainProvider> {
  if (!hasIon) return new Cesium.EllipsoidTerrainProvider();
  try {
    return await Cesium.createWorldTerrainAsync({ requestVertexNormals: true });
  } catch {
    return new Cesium.EllipsoidTerrainProvider();
  }
}

/**
 * Scene config that the rest of the app assumes.
 *
 * Imagery is no longer set up here: it is selected at runtime from the
 * registry in lib/cesium/imagery.ts and swapped by an effect in CesiumRoot.
 * What remains is the scene-level half of the gisDark treatment, which is
 * applied unconditionally -- the globe base colour and atmosphere have to
 * match the dimmed imagery whichever provider is showing, and they are what
 * the 'none' provider falls back to displaying.
 */
export function configureScene(viewer: Cesium.Viewer): void {
  const scene = viewer.scene;
  scene.globe.depthTestAgainstTerrain = true;
  scene.skyAtmosphere.show = true;
  scene.screenSpaceCameraController.enableCollisionDetection = false;
  scene.screenSpaceCameraController.minimumZoomDistance = 40;
  scene.screenSpaceCameraController.maximumZoomDistance = 6000;
  scene.backgroundColor = SCENE_BACKGROUND;
  // Sets baseColor, fog, atmosphere shifts, and pins lighting and HDR off.
  applyGisDarkScene(scene);
}

/**
 * The single non-CameraDirector camera call: framing the AOI on first paint.
 * The README documents this as the one exception to "all camera motion lives
 * in CameraDirector" — it is the scene's initial pose, not a transition.
 */
export function frameInitialCamera(viewer: Cesium.Viewer): void {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      (AOI.west + AOI.east) / 2,
      (AOI.south + AOI.north) / 2,
      1200,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(35),
      pitch: Cesium.Math.toRadians(-55),
      roll: 0,
    },
  });
}

/** Sample terrain height under every building centroid. */
export async function sampleGroundUnder(
  terrainProvider: Cesium.TerrainProvider,
  buildings: GeoFC<BuildingProps>,
): Promise<GroundMap> {
  const points: SamplePoint[] = buildings.features.map((f) => {
    const ring = (f.geometry.coordinates as number[][][])[0];
    const { lon, lat } = ringCentroid(ring);
    return { id: f.properties.id, lon, lat };
  });
  return sampleGroundHeights(terrainProvider, points);
}

/** Parallel fetch of the four cadastre endpoints used at boot. */
export async function fetchInitialData(): Promise<{
  buildings: GeoFC<BuildingProps>;
  parcels: GeoFC<ParcelInfo>;
  utilities: GeoFC<UtilityProps>;
  conflicts: ConflictRow[];
}> {
  const [bRes, pRes, uRes, cRes] = await Promise.all([
    fetch('/api/buildings'),
    fetch('/api/parcels'),
    fetch('/api/utilities'),
    fetch('/api/conflicts'),
  ]);
  const buildings = (await bRes.json()) as GeoFC<BuildingProps>;
  const parcels = (await pRes.json()) as GeoFC<ParcelInfo>;
  const utilities = (await uRes.json()) as GeoFC<UtilityProps>;
  const rawConflicts = (await cRes.json()) as ConflictRow[];
  return {
    buildings,
    parcels,
    utilities,
    conflicts: Array.isArray(rawConflicts) ? rawConflicts : [],
  };
}

/**
 * Subscribed camera height, in metres above the WGS84 ellipsoid.
 *
 * Updated on `scene.postRender` so the scale bar in the StatusBar tracks the
 * camera in real time. We read the value off the live Cesium.Viewer rather
 * than driving it from the React tree, because the camera is owned by
 * CameraDirector and the React tree is read-only here.
 */
export function useCameraHeight(viewer: Cesium.Viewer | null): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const scene = viewer.scene;
    const handler = () => {
      const carto = scene.camera.positionCartographic;
      if (!carto) return;
      setHeight(carto.height);
    };
    // Seed once so the bar renders before the first postRender fires.
    handler();
    scene.postRender.addEventListener(handler);
    return () => {
      if (!scene.isDestroyed()) scene.postRender.removeEventListener(handler);
    };
  }, [viewer]);
  return height;
}