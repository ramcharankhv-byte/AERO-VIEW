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
 * How deep to drill past geometry we do not want.
 *
 * Four used to be enough to clear Google's mesh plus a roof face. An isolated
 * floor adds two more translucent surfaces in front of every flat -- the height
 * shell and, at grazing angles, the base plate -- so the drill has to see one
 * storey deep without walking the entire ray through the stack.
 */
const DRILL_LIMIT = 6;

/**
 * Minimum gap between hover picks.
 *
 * A pointer emits move events far faster than the hover state can usefully
 * change, and each one costs a scene.pick plus a possible drillPick. ~30 ms is
 * under one frame at 30 fps, so the tooltip still tracks the cursor while the
 * picking cost stops scaling with mouse speed. Clicks are never throttled --
 * a dropped click is a bug, a dropped hover sample is not.
 */
const HOVER_THROTTLE_MS = 30;

/**
 * The tag under the cursor, seeing past geometry that carries no tag, and
 * preferring a UNIT to whatever is in front of it.
 *
 * Two problems solved by one drill.
 *
 * In Photoreal mode the topmost hit is a Cesium3DTileFeature from Google's
 * tileset, which has no tag and is opaque -- so a plain scene.pick would report
 * nothing and selection would die the moment the tiles came on. The ghosted
 * schematic extrusion is still right behind it, so we drill for it.
 *
 * On an isolated floor the topmost hit is usually the level's translucent
 * height shell, which encloses every flat on that level. Accepting it would
 * make the flats unpickable -- the exact defect the old solid slab had. So the
 * drill collects what the ray passes through and the SHALLOWEST unit wins;
 * the plate or shell only resolves as the floor when the ray found no unit at
 * all, which is semantically right: that is the level's own space, the
 * corridors and common areas that belong to no flat.
 *
 * The fast path is unchanged for a plain city pick: one scene.pick, and the
 * drill is only reached when the first hit was untagged or was not a unit.
 */
function pickTag(scene: Cesium.Scene, position: Cesium.Cartesian2): EntityTag | null {
  const picked = scene.pick(position);
  const first = tagOf(picked);
  if (first?.kind === 'unit') return first;
  // Empty sky or a bare globe: there is nothing behind it to drill for, and
  // this path runs on every throttled mouse move.
  if (picked === undefined) return null;

  let fallback: EntityTag | null = first;
  for (const candidate of scene.drillPick(position, DRILL_LIMIT)) {
    const tag = tagOf(candidate);
    if (!tag) continue;
    if (tag.kind === 'unit') return tag;      // topmost unit wins outright
    fallback ??= tag;                          // otherwise the first tagged hit
  }
  return fallback;
}

export default function Picker() {
  const { viewer, ready } = useViewer();
  const selectBuilding = useViewStore((s) => s.selectBuilding);
  const isolateFloor = useViewStore((s) => s.isolateFloor);
  const selectUnit = useViewStore((s) => s.selectUnit);
  const openUnit = useViewStore((s) => s.openUnit);
  const selectUtility = useViewStore((s) => s.selectUtility);
  const setHover = useViewStore((s) => s.setHover);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    let lastPick = 0;
    handler.setInputAction((movement: { endPosition: Cesium.Cartesian2 }) => {
      const now = performance.now();
      if (now - lastPick < HOVER_THROTTLE_MS) return;
      lastPick = now;
      const tag = pickTag(viewer.scene, movement.endPosition);
      // Both hover targets in one write: they are live at the same time and two
      // writes would render the scene twice for a single mouse move.
      setHover(
        tag?.kind === 'building' ? tag.id : null,
        tag?.kind === 'unit' ? tag.id : null,
      );
      viewer.scene.canvas.style.cursor = tag ? 'pointer' : 'default';
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const tag = pickTag(viewer.scene, click.position);
      if (!tag) return;   // clicking empty sky/ground is not a deselect gesture
      switch (tag.kind) {
        case 'unit':
          // From the exploded stack in building mode the flat's level is not
          // isolated yet. openUnit sets the level AND the unit in one write, so
          // no subscriber ever sees a half-applied navigation.
          if (tag.level !== undefined) openUnit(tag.level, tag.id);
          else selectUnit(tag.id);
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
      setHover(null, null);
      if (!handler.isDestroyed()) handler.destroy();
    };
  }, [viewer, ready, selectBuilding, isolateFloor, selectUnit, openUnit,
      selectUtility, setHover]);

  return null;
}
