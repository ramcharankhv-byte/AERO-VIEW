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
import type {
  ConflictRow, EnrichedBuilding, GeoFC, ParcelInfo, RoadProps, UtilityProps,
} from '@/lib/types';

/**
 * The demo AOI, as a constant.
 *
 * Kept because lib/cesium/imagery.ts bounds the optional drone-orthophoto
 * provider to it, and that pyramid is a flight over Siripuram specifically --
 * a bbox from another project would ask a tile server for photographs that do
 * not exist. Everything else takes the bbox from the project row; see
 * frameInitialCamera below.
 */
export const AOI = {
  west: 83.313,
  south: 17.718,
  east: 83.3245,
  north: 17.728,
};

/** west, south, east, north — the order the project row and the CLI both use. */
export type Bbox = readonly [number, number, number, number];

export const DEMO_BBOX: Bbox = [AOI.west, AOI.south, AOI.east, AOI.north];

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

/** The height that frames a bbox of this size at a 55-degree pitch. */
export function frameHeightFor(bbox: Bbox): number {
  const [west, south, east, north] = bbox;
  const midLat = (south + north) / 2;
  const widthM = Math.abs(east - west) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = Math.abs(north - south) * 110574;
  // 1200 m is the height the demo AOI has always opened at. Scaling by the
  // larger dimension relative to it keeps a smaller ward from opening as a
  // speck and a larger one from overflowing the frame, and returns exactly
  // 1200 for a bbox the size of Siripuram's.
  const span = Math.max(widthM, heightM);
  return Math.round((span / 1220) * 1200);
}

/**
 * The single non-CameraDirector camera call: framing the project on first
 * paint. The README documents this as the one exception to "all camera motion
 * lives in CameraDirector" — it is the scene's initial pose, not a transition.
 *
 * It takes the project's bbox now instead of reading a module constant. That
 * is the whole of the change: still one call, still at construction, still the
 * only setView in the application.
 */
export function frameInitialCamera(viewer: Cesium.Viewer, bbox: Bbox = DEMO_BBOX): void {
  const [west, south, east, north] = bbox;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      (west + east) / 2,
      (south + north) / 2,
      frameHeightFor(bbox),
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
  buildings: GeoFC<EnrichedBuilding>,
): Promise<GroundMap> {
  const points: SamplePoint[] = buildings.features.map((f) => {
    const ring = (f.geometry.coordinates as number[][][])[0];
    const { lon, lat } = ringCentroid(ring);
    return { id: f.properties.id, lon, lat };
  });
  return sampleGroundHeights(terrainProvider, points);
}

/** Parallel fetch of one project's cadastre endpoints used at boot. */
export async function fetchInitialData(slug: string): Promise<{
  buildings: GeoFC<EnrichedBuilding>;
  parcels: GeoFC<ParcelInfo>;
  utilities: GeoFC<UtilityProps>;
  roads: GeoFC<RoadProps>;
  conflicts: ConflictRow[];
}> {
  const EMPTY_ROADS: GeoFC<RoadProps> = { type: 'FeatureCollection', features: [] };
  const base = `/api/p/${encodeURIComponent(slug)}`;
  const [bRes, pRes, uRes, cRes, rRes] = await Promise.all([
    fetch(`${base}/buildings`),
    fetch(`${base}/parcels`),
    fetch(`${base}/utilities`),
    fetch(`${base}/conflicts`),
    // Caught on its own rather than inside the Promise.all: a rejection there
    // fails the whole boot and CesiumRoot renders an empty scene. Footprints
    // are the application; streets are orientation context, and losing them
    // must not cost the user the cadastre.
    fetch(`${base}/roads`).catch(() => null),
  ]);
  const buildings = (await bRes.json()) as GeoFC<EnrichedBuilding>;
  const parcels = (await pRes.json()) as GeoFC<ParcelInfo>;
  const utilities = (await uRes.json()) as GeoFC<UtilityProps>;
  const rawConflicts = (await cRes.json()) as ConflictRow[];
  const roads = rRes && rRes.ok
    ? ((await rRes.json()) as GeoFC<RoadProps>)
    : EMPTY_ROADS;
  return {
    buildings,
    parcels,
    utilities,
    roads: Array.isArray(roads?.features) ? roads : EMPTY_ROADS,
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
 *
 * The viewer runs in requestRenderMode, so postRender only fires on frames
 * that actually render -- which is exactly when the camera can have moved.
 * The camera-move event below covers flights; the preRender listener covers
 * user orbit/zoom gestures, which move the camera without a store change.
 */
export function useCameraHeight(viewer: Cesium.Viewer | null): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const scene = viewer.scene;
    let raf = 0;
    const handler = () => {
      const carto = scene.camera.positionCartographic;
      if (!carto) return;
      setHeight(carto.height);
    };
    // Camera moves, including gestures, request a render; reading the height
    // on the following preRender keeps the bar live without a render loop of
    // its own.
    const onChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(handler);
    };
    scene.camera.changed.addEventListener(onChange);
    // Seed once so the bar renders before the first camera event.
    handler();
    scene.postRender.addEventListener(handler);
    return () => {
      cancelAnimationFrame(raf);
      scene.camera.changed.removeEventListener(onChange);
      if (!scene.isDestroyed()) scene.postRender.removeEventListener(handler);
    };
  }, [viewer]);
  return height;
}