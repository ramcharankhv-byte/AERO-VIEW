'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useViewStore } from '@/lib/store';
import { createBhuvanLayer } from '@/lib/cesium/imagery';
import { BHUVAN_KINDS, BHUVAN_LAYER_KEY, type BhuvanKind } from '@/lib/bhuvan';

type Made = Partial<Record<BhuvanKind, Cesium.ImageryLayer>>;

/**
 * ISRO Bhuvan WMS context overlays: land use / land cover, flood hazard
 * zones, cyclone hazard zones.
 *
 * Render-only: reads the layer flags and the project's bhuvan_layers block,
 * never writes the store, never moves the camera. Each overlay is an
 * ImageryLayer APPENDED to viewer.imageryLayers, i.e. above the basemap that
 * CesiumRoot keeps at index 0 -- and CesiumRoot swaps that basemap by
 * reference, not with removeAll(), so a basemap change leaves these in place.
 *
 * Off by default, and a hidden ImageryLayer requests no tiles, so a project
 * whose user never switches one on never touches nrsc.gov.in.
 */
export default function BhuvanOverlayLayer() {
  const { viewer, project } = useViewer();
  const flags = useViewStore((s) => s.layers);
  const made = useRef<Made>({});
  const bhuvan = project?.bhuvan_layers ?? null;

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !project || !bhuvan) return undefined;
    const created: Made = {};
    for (const kind of BHUVAN_KINDS) {
      const name = bhuvan[kind];
      if (!name) continue;
      const layer = createBhuvanLayer(kind, name, project.bbox);
      layer.show = useViewStore.getState().layers[BHUVAN_LAYER_KEY[kind]];
      viewer.imageryLayers.add(layer);
      created[kind] = layer;
    }
    made.current = created;
    viewer.scene.requestRender();
    return () => {
      made.current = {};
      if (viewer.isDestroyed()) return;
      for (const l of Object.values(created)) {
        if (l && viewer.imageryLayers.contains(l)) viewer.imageryLayers.remove(l, true);
      }
    };
  }, [viewer, project, bhuvan]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    let changed = false;
    for (const kind of BHUVAN_KINDS) {
      const l = made.current[kind];
      if (!l) continue;
      const want = flags[BHUVAN_LAYER_KEY[kind]];
      if (l.show !== want) {
        l.show = want;
        changed = true;
      }
    }
    if (changed) viewer.scene.requestRender();
  }, [viewer, flags, bhuvan]);

  return null;
}
