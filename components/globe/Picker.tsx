'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect } from 'react';
import { useViewer } from './CesiumRoot';
import { useViewStore } from '@/lib/store';
import { tagOf } from '@/lib/cesium/tag';

/**
 * Mouse -> store.
 *
 * ARCHITECTURE RULE: this component and the UI controls are the ONLY writers to
 * the view store. Layers read it. Nothing here touches the camera.
 */
export default function Picker() {
  const { viewer, ready } = useViewer();
  const selectBuilding = useViewStore((s) => s.selectBuilding);
  const isolateFloor = useViewStore((s) => s.isolateFloor);
  const selectUnit = useViewStore((s) => s.selectUnit);
  const selectUtility = useViewStore((s) => s.selectUtility);
  const setHovered = useViewStore((s) => s.setHovered);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((movement: { endPosition: Cesium.Cartesian2 }) => {
      const tag = tagOf(viewer.scene.pick(movement.endPosition));
      setHovered(tag?.kind === 'building' ? tag.id : null);
      viewer.scene.canvas.style.cursor = tag ? 'pointer' : 'default';
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const tag = tagOf(viewer.scene.pick(click.position));
      if (!tag) return;   // clicking empty sky/ground is not a deselect gesture
      switch (tag.kind) {
        case 'unit':
          selectUnit(tag.id);
          break;
        case 'floor':
          if (tag.level !== undefined) isolateFloor(tag.level);
          break;
        case 'utility':
          selectUtility(tag.id);
          break;
        case 'building':
          selectBuilding(tag.id);
          break;
        default:
          break;
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      setHovered(null);
      if (!handler.isDestroyed()) handler.destroy();
    };
  }, [viewer, ready, selectBuilding, isolateFloor, selectUnit, selectUtility, setHovered]);

  return null;
}
