'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import React, {
  createContext, useContext, useEffect, useRef, useState,
} from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import type { GroundMap } from '@/lib/cesium/terrain';
import { applyTreatment, createImageryLayer } from '@/lib/cesium/imagery';
import {
  applyPhotorealTranslucency, createPhotorealTileset, photorealFailureMessage,
} from '@/lib/cesium/photoreal';
import {
  configureScene, createTerrain, fetchInitialData, frameInitialCamera,
  hasIonToken, sampleGroundUnder,
} from '@/lib/cesium/setup';
import { applySun } from '@/lib/cesium/sun';
import {
  applyPerformanceProfile, attachAdaptiveResolution, detectWeakGpu,
} from '@/lib/cesium/perf';
import { useUrlState } from '@/lib/url-state';

/**
 * Viewer lifecycle and one-time data load.
 *
 * This component owns the Cesium Viewer and nothing else owns it. Layers reach
 * the viewer through useViewer(); they read the store and render, and they do
 * not move the camera -- CameraDirector does that, exclusively.
 *
 * Everything that can fail at construction (terrain fetch, imagery load,
 * terrain sampling, network) lives in lib/cesium/setup.ts so this file reads
 * as the orchestration it actually is.
 */

interface ViewerCtx {
  viewer: Cesium.Viewer | null;
  ground: GroundMap;
  ready: boolean;
}

const Ctx = createContext<ViewerCtx>({ viewer: null, ground: new Map(), ready: false });

export function useViewer(): ViewerCtx {
  return useContext(Ctx);
}

export default function CesiumRoot({ children }: { children?: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const [ctx, setCtx] = useState<ViewerCtx>({ viewer: null, ground: new Map(), ready: false });

  /**
   * The terrain provider chosen at boot, kept so Photoreal mode can put it
   * back. Google's tiles carry their own terrain, so World Terrain has to come
   * off while they are up or the two surfaces fight; this is what "on" means
   * when the user switches back.
   */
  const baseTerrainRef = useRef<Cesium.TerrainProvider | null>(null);
  /** Disposer for the adaptive-resolution watchdog started in the mount effect. */
  const stopAdaptiveRef = useRef<(() => void) | null>(null);
  /** Set at boot; sizes the shadow map when the sun is switched on. */
  const weakGpuRef = useRef(false);

  const setIonFallback = useViewStore((s) => s.setIonFallback);
  const loading = useDataStore((s) => s.loading);

  // Restore the shared view before the scene reads any of it, and keep the
  // address bar in step from here on. Lives in this client-only component so
  // reading window.location during render cannot desync a server render.
  useUrlState();

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    let disposed = false;

    (async () => {
      const hasIon = hasIonToken();
      if (hasIon) Cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN!.trim();

      const terrainProvider = await createTerrain(hasIon);
      baseTerrainRef.current = terrainProvider;
      if (disposed || !containerRef.current) return;

      const viewer = new Cesium.Viewer(containerRef.current, {
        terrainProvider,
        // Suppress the default ion base layer. Without this the Viewer fires a
        // request for ion asset 2 using Cesium's built-in demo token before we
        // ever get to swap imagery, which 401s when no token is configured.
        baseLayer: false,
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        scene3DOnly: true,
        // Continuous rendering burns battery and crowds out the compositor on
        // integrated GPUs. With on-demand rendering the scene re-renders only
        // when something actually changes (camera, data, an animation
        // callback); CameraDirector's flights and the explode slider both
        // trigger renders through Cesium's own requestRender paths. Auto-spin
        // drives camera.rotate on clock ticks, which also re-renders.
        requestRenderMode: true,
        // A long idle gap followed by a camera move used to show a stale
        // frame briefly; this bounds the wait so interactions still feel live.
        maximumRenderTimeChange: 2.0,
      });
      viewerRef.current = viewer;

      // GPU profile: probe once, configure once. The adaptive-resolution
      // watchdog only re-renders when it changes the scale, so in
      // requestRenderMode it costs nothing while the scene is idle.
      const profile = { lowEnd: detectWeakGpu() };
      weakGpuRef.current = profile.lowEnd;
      applyPerformanceProfile(viewer, profile);
      stopAdaptiveRef.current = attachAdaptiveResolution(viewer);

      // Test seam for scripts/check_photoreal.mjs. Scene state such as
      // globe.show, the live terrain provider and the tileset primitive has no
      // DOM representation, so an acceptance check has no other way to assert
      // it. Development only -- this is not part of the app's API and is
      // compiled out of a production build.
      if (process.env.NODE_ENV !== 'production') {
        (window as unknown as { __ulpinViewer?: Cesium.Viewer }).__ulpinViewer = viewer;
      }

      // The credit container is left exactly as Cesium builds it. Esri, Maxar
      // and OSM attribution are licence obligations, not chrome; globals.css
      // only moves the box clear of the StatusBar.

      // Imagery is not added here. The provider effect below owns layer 0 and
      // runs on mount like any other, so there is one code path for the first
      // basemap and every subsequent swap.
      setIonFallback(!hasIon || terrainProvider instanceof Cesium.EllipsoidTerrainProvider);

      configureScene(viewer);
      // The on-demand render loop must know what counts as "changed". 0.5
      // degrees of heading/pitch and ~1% of height cover both orbit gestures
      // and the tail of a camera flight, so every real move requests a frame.
      viewer.scene.camera.percentageChanged = 0.01;
      frameInitialCamera(viewer);

      // ---- one-time data load -------------------------------------------
      const store = useDataStore.getState();
      store.setLoading(true);
      try {
        const data = await fetchInitialData();
        if (disposed) return;
        store.setBuildings(data.buildings);
        store.setParcels(data.parcels);
        store.setUtilities(data.utilities);
        store.setRoads(data.roads);
        store.setConflicts(data.conflicts);

        const ground = await sampleGroundUnder(terrainProvider, data.buildings);
        if (disposed) return;
        setCtx({ viewer, ground, ready: true });
      } catch (err) {
        store.setError(String(err));
        if (!disposed) setCtx({ viewer, ground: new Map(), ready: true });
      } finally {
        useDataStore.getState().setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      stopAdaptiveRef.current?.();
      const v = viewerRef.current;
      viewerRef.current = null;
      if (v && !v.isDestroyed()) v.destroy();
    };
    // Intentionally mount-only: the viewer must be constructed exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- underground mode: globe translucency ------------------------------
  // Scene state, not camera state, so it belongs with the viewer rather than
  // in CameraDirector (which only handles the accompanying pitch change).
  const underground = useViewStore((s) => s.underground);
  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const globe = viewer.scene.globe;

    if (underground) {
      globe.translucency.enabled = true;
      globe.translucency.frontFaceAlphaByDistance = new Cesium.NearFarScalar(
        420, 0.28, 1800, 0.85,
      );
      globe.depthTestAgainstTerrain = false;
      viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    } else {
      // Disabling translucency is enough; the distance ramp is reapplied on the
      // next enable, so it is left in place rather than cleared.
      globe.translucency.enabled = false;
      globe.depthTestAgainstTerrain = true;
    }
  }, [ctx.viewer, underground]);

  // ---- sun / time of day --------------------------------------------------
  // Scene state like the two effects around it. applyGisDarkScene() pins globe
  // lighting off at boot and is only called from configureScene(), so this runs
  // after it once and is never undone by a later tone or provider switch.
  const sunHour = useViewStore((s) => s.sunHour);
  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    applySun(viewer, sunHour, weakGpuRef.current);
  }, [ctx.viewer, sunHour]);

  // ---- navigation mode ----------------------------------------------------
  // Which mouse gestures the camera controller accepts. Scene configuration,
  // not camera movement, so it lives here rather than in CameraDirector.
  const navMode = useViewStore((s) => s.navMode);
  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const c = viewer.scene.screenSpaceCameraController;
    c.enableRotate = navMode === 'orbit';
    c.enableTilt = navMode === 'orbit';
    c.enableTranslate = navMode === 'pan' || navMode === 'orbit';
    c.enableZoom = true;
    c.enableLook = navMode === 'orbit';
  }, [ctx.viewer, navMode]);

  // ---- basemap imagery ----------------------------------------------------
  // Swapping provider replaces layer 0 in place. The viewer is not rebuilt and
  // the camera is never touched here, so the view survives a swap by
  // construction rather than by saving and restoring a pose.
  const imageryProvider = useViewStore((s) => s.imageryProvider);
  const imageryTreatment = useViewStore((s) => s.imageryTreatment);
  const imageryActive = useViewStore((s) => s.imageryActive);
  const setImageryActive = useViewStore((s) => s.setImageryActive);
  const showBasemap = useViewStore((s) => s.layers.basemap);
  const showTerrain = useViewStore((s) => s.layers.terrain);

  // Monotonic request token. A boolean "cancelled" flag is not enough: a slow
  // Esri load resolving after the user has already moved on to CARTO would
  // otherwise overwrite the newer layer.
  const imageryReqRef = useRef(0);

  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const req = ++imageryReqRef.current;

    (async () => {
      // createImageryLayer never throws; it resolves to carto, then to a null
      // layer, so there is no path here that leaves the globe untextured by
      // accident.
      const { id, layer } = await createImageryLayer(imageryProvider);
      if (req !== imageryReqRef.current || viewer.isDestroyed()) return;

      viewer.imageryLayers.removeAll();
      if (layer) {
        viewer.imageryLayers.add(layer, 0);
        applyTreatment(layer, useViewStore.getState().imageryTreatment);
        layer.show = useViewStore.getState().layers.basemap;
      }
      setImageryActive(id);
    })();
  }, [ctx.viewer, imageryProvider, setImageryActive]);

  // Retone in place. Depends on imageryActive so a freshly swapped layer picks
  // up the current tone as well.
  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed() || viewer.imageryLayers.length === 0) return;
    applyTreatment(viewer.imageryLayers.get(0), imageryTreatment);
  }, [ctx.viewer, imageryTreatment, imageryActive]);

  // ---- basemap / terrain layer toggles ------------------------------------
  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    // The 'none' provider legitimately leaves the collection empty.
    if (viewer.imageryLayers.length === 0) return;
    viewer.imageryLayers.get(0).show = showBasemap;
  }, [ctx.viewer, showBasemap, imageryActive]);

  // ---- photoreal: the Google 3D Tiles primitive ---------------------------
  // The only primitive in the app. Created lazily and destroyed on the way
  // out, so a session that stays in Schematic never spends Google quota.
  const buildingStyle = useViewStore((s) => s.buildingStyle);
  const failPhotoreal = useViewStore((s) => s.failPhotoreal);
  const tilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);

  // Same monotonic-token guard as the imagery swap: a slow tileset resolving
  // after the user has flicked back to Schematic must not add itself anyway.
  const photorealReqRef = useRef(0);

  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const req = ++photorealReqRef.current;
    if (buildingStyle !== 'photoreal') return;

    (async () => {
      try {
        const tileset = await createPhotorealTileset();
        if (req !== photorealReqRef.current || viewer.isDestroyed()) {
          // Arrived too late to be wanted. Nothing added it to the scene, so
          // nothing else will ever free it.
          if (!tileset.isDestroyed()) tileset.destroy();
          return;
        }
        viewer.scene.primitives.add(tileset);
        tilesetRef.current = tileset;
        applyPhotorealTranslucency(tileset, useViewStore.getState().underground);
      } catch (err) {
        if (req !== photorealReqRef.current) return;
        console.warn('[photoreal] Google 3D Tiles failed to load:', err);
        // Writes buildingStyle back to 'schematic', which re-runs this effect
        // and the terrain effect below, so the fallback is a real state change
        // rather than a message over a broken scene.
        failPhotoreal(photorealFailureMessage(err));
      }
    })();

    return () => {
      const tileset = tilesetRef.current;
      tilesetRef.current = null;
      if (tileset && !viewer.isDestroyed() && !tileset.isDestroyed()) {
        // primitives.remove() destroys by default, releasing the tile cache.
        viewer.scene.primitives.remove(tileset);
      }
    };
  }, [ctx.viewer, buildingStyle, failPhotoreal]);

  // Underground has to see through the tiles the way it sees through the
  // globe. Separate effect so toggling underground never rebuilds the tileset.
  useEffect(() => {
    const tileset = tilesetRef.current;
    if (!tileset || tileset.isDestroyed()) return;
    applyPhotorealTranslucency(tileset, underground);
  }, [underground, buildingStyle, ctx.viewer]);

  // ---- terrain provider + globe visibility --------------------------------
  // One effect owns both, because in photoreal mode they move together: the
  // tiles supply the ground, so World Terrain comes off and the globe surface
  // is hidden rather than left to z-fight the mesh across a hilly AOI.
  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const photoreal = buildingStyle === 'photoreal';

    // Assign only on a real change: every write fires terrainProviderChanged
    // and re-tiles the globe, and this effect also runs for layer toggles.
    // Ground heights are NOT re-sampled -- the stacks were reconciled against
    // World Terrain at boot and must stay where that put them, which is also
    // what keeps them registered with Google's mesh.
    const wanted =
      photoreal || !baseTerrainRef.current
        ? new Cesium.EllipsoidTerrainProvider()
        : baseTerrainRef.current;
    const isEllipsoidNow = viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider;
    const wantEllipsoid = wanted instanceof Cesium.EllipsoidTerrainProvider;
    if (isEllipsoidNow !== wantEllipsoid) viewer.terrainProvider = wanted;

    // Dropping to ellipsoid terrain is the honest "terrain off" state; the
    // stacks stay put because their scene Z is reconciled, not re-sampled.
    viewer.scene.globe.show = !photoreal && (showTerrain || showBasemap);
  }, [ctx.viewer, showTerrain, showBasemap, buildingStyle]);

  return (
    <Ctx.Provider value={ctx}>
      {/* touch-none: Cesium installs its own pointer handlers for pan,
          pinch and rotate. Without this the browser claims a two-finger
          gesture as page zoom before Cesium ever sees it, and the globe
          becomes undraggable on a phone. select-none stops a drag over the
          canvas from starting a text selection. */}
      <div ref={containerRef} className="absolute inset-0 touch-none select-none" />
      {ctx.ready ? children : null}
      {loading ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="glass rounded-lg px-4 py-2 text-sm text-ink">
            Loading cadastre…
          </div>
        </div>
      ) : null}
    </Ctx.Provider>
  );
}