'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect } from 'react';
import { useViewer } from './CesiumRoot';
import { useViewStore } from '@/lib/store';
import { tagOf, type EntityTag } from '@/lib/cesium/tag';

/**
 * Mouse -> store.
 *
 * ARCHITECTURE RULE: this component and the UI controls are the ONLY writers to
 * the view store. Layers read it. Nothing here touches the camera.
 */

/**
 * How deep to drill past untagged geometry. Four is enough to clear Google's
 * mesh plus a roof face; an unbounded drill would walk the entire ray through
 * 384 translucent extrusions on every mouse move.
 */
const DRILL_LIMIT = 4;

/**
 * Minimum gap between hover picks.
 *
 * A pointer emits move events far faster than the hover state can usefully
 * change, and each one costs a scene.pick plus a possible four-deep drillPick.
 * ~30 ms is under one frame at 30 fps, so the tooltip still tracks the cursor
 * while the picking cost stops scaling with mouse speed. Clicks are never
 * throttled -- a dropped click is a bug, a dropped hover sample is not.
 */
const HOVER_THROTTLE_MS = 30;

/**
 * The tag under the cursor, seeing past geometry that carries no tag.
 *
 * In Photoreal mode the topmost hit is a Cesium3DTileFeature from Google's
 * tileset, which has no tag and is opaque -- so a plain scene.pick would report
 * nothing and selection would die the moment the tiles came on. The ghosted
 * schematic extrusion is still right behind it, so we drill for it.
 *
 * The fast path is unchanged for Schematic mode: one scene.pick, and drillPick
 * is only reached when something untagged was actually hit. An empty sky or a
 * bare globe pick returns undefined and never drills.
 */
function pickTag(scene: Cesium.Scene, position: Cesium.Cartesian2): EntityTag | null {
  const picked = scene.pick(position);
  const tag = tagOf(picked);
  if (tag) return tag;
  if (picked === undefined) return null;

  for (const candidate of scene.drillPick(position, DRILL_LIMIT)) {
    const deeper = tagOf(candidate);
    if (deeper) return deeper;
  }
  return null;
}
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

    let lastPick = 0;
    handler.setInputAction((movement: { endPosition: Cesium.Cartesian2 }) => {
      const now = performance.now();
      if (now - lastPick < HOVER_THROTTLE_MS) return;
      lastPick = now;
      const tag = pickTag(viewer.scene, movement.endPosition);
      setHovered(tag?.kind === 'building' ? tag.id : null);
      viewer.scene.canvas.style.cursor = tag ? 'pointer' : 'default';
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const tag = pickTag(viewer.scene, click.position);
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
