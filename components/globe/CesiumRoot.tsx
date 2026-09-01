'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import React, {
  createContext, useContext, useEffect, useRef, useState,
} from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import type { GroundMap } from '@/lib/cesium/terrain';
import {
  AOI, addInitialImagery, configureScene, createTerrain, fetchInitialData,
  frameInitialCamera, hasIonToken, sampleGroundUnder,
} from '@/lib/cesium/setup';

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

  const setIonFallback = useViewStore((s) => s.setIonFallback);
  const loading = useDataStore((s) => s.loading);

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    let disposed = false;

    (async () => {
      const hasIon = hasIonToken();
      if (hasIon) Cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN!.trim();

      const terrainProvider = await createTerrain(hasIon);
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
        requestRenderMode: false,
      });
      viewerRef.current = viewer;
      viewer.cesiumWidget.creditContainer.setAttribute('style', 'display:none');

      const usedFallback = await addInitialImagery(viewer, hasIon);
      setIonFallback(usedFallback);

      configureScene(viewer);
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

  // ---- basemap / terrain layer toggles ------------------------------------
  const showBasemap = useViewStore((s) => s.layers.basemap);
  const showTerrain = useViewStore((s) => s.layers.terrain);
  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      viewer.imageryLayers.get(i).show = showBasemap;
    }
  }, [ctx.viewer, showBasemap]);

  useEffect(() => {
    const viewer = ctx.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    // Dropping to ellipsoid terrain is the honest "terrain off" state; the
    // stacks stay put because their scene Z is reconciled, not re-sampled.
    viewer.scene.globe.show = showTerrain || showBasemap;
  }, [ctx.viewer, showTerrain, showBasemap]);

  return (
    <Ctx.Provider value={ctx}>
      <div ref={containerRef} className="absolute inset-0" />
      {ctx.ready ? children : null}
      {loading ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="glass rounded-lg px-4 py-2 text-sm text-slate-200">
            Loading cadastre…
          </div>
        </div>
      ) : null}
    </Ctx.Provider>
  );
}