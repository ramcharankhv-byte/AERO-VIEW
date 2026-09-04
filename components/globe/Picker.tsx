'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from './CesiumRoot';
import { useViewStore } from '@/lib/store';
import { tagOf, type EntityTag } from '@/lib/cesium/tag';
import { ROAD_PICK_PX } from '@/lib/cesium/materials';

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
function pickTag(
  scene: Cesium.Scene,
  position: Cesium.Cartesian2,
  roadsVisible: boolean,
  /**
   * Whether to spend the widened road pass.
   *
   * TRUE FOR CLICKS ONLY. A dropped click is a bug; a hover sample that does
   * not light a street the cursor is not quite on is not. Running it on hover
   * would mean up to four extra pick renders every 30 ms for as long as the
   * pointer sits over empty ground -- paid continuously, to produce a
   * highlight the user did not ask for.
   */
  widen: boolean,
  /**
   * Whether a UNIT could possibly be under this cursor.
   *
   * The drill below exists for two things: seeing past untagged geometry
   * (Google's photoreal mesh), and preferring a unit to whatever is in front
   * of it. In city mode the second reason cannot apply -- UnitsLayer has
   * drawn nothing -- so when the first hit is already a tagged solid, the
   * drill is pure cost.
   *
   * And it is not a small cost. scene.drillPick(6) renders the scene into the
   * pick framebuffer up to six times; measured at 88 ms here against 15 ms for
   * a single scene.pick. Paid every 30 ms while the pointer is over the city,
   * it was the single largest source of main-thread blocking during
   * interaction -- 4.3 s of blocking across one camera drag
   * (docs/perf/findings.md).
   */
  unitsPossible = true,
): EntityTag | null {
  const picked = scene.pick(position);
  const first = tagOf(picked);
  if (first?.kind === 'unit') return first;

  // The fast path: a tagged solid, and nothing better could be hiding behind
  // it. One pick render instead of seven.
  if (!unitsPossible && first && first.kind !== 'road' && first.kind !== 'parcel') {
    return first;
  }

  // Ground-classified kinds are draped on the terrain, so they are behind every
  // solid by construction -- but they are also the only things under a click on
  // bare ground. Collecting them in strictly lower tiers is what lets a street
  // be clickable without ever winning a ray that also touched a building.
  //
  // The existing four kinds keep pure depth order between themselves: clicking
  // THROUGH a neighbouring building to reach an isolated floor behind it
  // correctly returns the building today, and a rank table would break that.
  const isGround = (k: EntityTag['kind']) => k === 'road' || k === 'parcel';
  let solid: EntityTag | null = first && !isGround(first.kind) ? first : null;
  let road: EntityTag | null = first?.kind === 'road' ? first : null;
  let parcel: EntityTag | null = first?.kind === 'parcel' ? first : null;

  if (picked !== undefined) {
    for (const candidate of scene.drillPick(position, DRILL_LIMIT)) {
      const tag = tagOf(candidate);
      if (!tag) continue;
      if (tag.kind === 'unit') return tag;      // topmost unit wins outright
      if (tag.kind === 'road') { road ??= tag; continue; }
      if (tag.kind === 'parcel') { parcel ??= tag; continue; }
      solid ??= tag;
    }
  }

  if (solid) return solid;
  if (road) return road;

  // Nothing solid and nothing exactly on a line: try again with a WIDENED
  // pick, roads only. A 2-3 px stroke is an unusable click target and the
  // brief requires selection to work when the user clicks near a street
  // rather than exactly on it.
  //
  // This is a widened pass rather than an invisible hit-corridor entity per
  // road for two reasons: it costs no entities and no GPU time at all, which
  // is what "must still work at thousands of streets" demands; and two
  // coplanar ground primitives (a corridor and a parcel fill) have no
  // well-defined depth order, so a corridor could lose the very click it
  // exists to catch. Because it runs ONLY after the tight pick found no solid,
  // the tolerance is road-exclusive -- it can never enlarge the target of a
  // building, a floor or a unit.
  if (widen && roadsVisible) {
    for (const candidate of scene.drillPick(position, 4, ROAD_PICK_PX, ROAD_PICK_PX)) {
      const tag = tagOf(candidate);
      if (tag?.kind === 'road') return tag;
    }
  }

  return parcel;
}

export default function Picker() {
  const { viewer, ready } = useViewer();
  const selectBuilding = useViewStore((s) => s.selectBuilding);
  const isolateFloor = useViewStore((s) => s.isolateFloor);
  const selectUnit = useViewStore((s) => s.selectUnit);
  const openUnit = useViewStore((s) => s.openUnit);
  const selectUtility = useViewStore((s) => s.selectUtility);
  const selectRoad = useViewStore((s) => s.selectRoad);
  const clearAmbient = useViewStore((s) => s.clearAmbient);
  const setHover = useViewStore((s) => s.setHover);
  const roadsVisible = useViewStore((s) => s.layers.roads);

  // Read through a ref inside the handlers rather than closed over: making it
  // an effect dependency would tear down and rebuild the ScreenSpaceEventHandler
  // every time the streets layer is toggled.
  const roadsVisibleRef = useRef(roadsVisible);
  useEffect(() => { roadsVisibleRef.current = roadsVisible; }, [roadsVisible]);

  /**
   * City mode means UnitsLayer has drawn nothing, so no drill is needed to
   * find a unit. Read through a ref for the same reason as roadsVisible:
   * making it a dependency would rebuild the event handler on every mode
   * change.
   */
  const mode = useViewStore((s) => s.mode);
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    let lastPick = 0;
    /**
     * True between mouse-down and mouse-up: the user is driving the camera.
     *
     * NOT HOVERING DURING A DRAG. Cesium delivers MOUSE_MOVE while a button is
     * held, so orbiting the globe used to run a hover pick every 30 ms for the
     * whole gesture -- and each of those was a scene.pick plus, usually, a
     * six-deep drillPick. That is the most expensive thing this application
     * does, spent on a highlight nobody asked for: a user dragging the camera
     * is navigating, not pointing at a building.
     *
     * Measured across one 30-step orbit: 4,315 ms of main-thread blocking with
     * this handler live, against 102 ms with the entity layers hidden. The
     * blocking was the picking, not the drawing.
     */
    let dragging = false;
    let hoverCleared = true;

    handler.setInputAction(() => {
      dragging = true;
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(() => {
      dragging = false;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
    // Middle and right drags are zoom and tilt; they move the camera too.
    handler.setInputAction(() => {
      dragging = true;
    }, Cesium.ScreenSpaceEventType.MIDDLE_DOWN);
    handler.setInputAction(() => {
      dragging = false;
    }, Cesium.ScreenSpaceEventType.MIDDLE_UP);
    handler.setInputAction(() => {
      dragging = true;
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN);
    handler.setInputAction(() => {
      dragging = false;
    }, Cesium.ScreenSpaceEventType.RIGHT_UP);

    handler.setInputAction((movement: { endPosition: Cesium.Cartesian2 }) => {
      if (dragging) {
        // Drop a stale highlight once, then stay silent for the rest of the
        // gesture. Leaving the old building lit while the camera swings away
        // from it reads as the tooltip being stuck.
        if (!hoverCleared) {
          hoverCleared = true;
          setHover(null, null, null);
          viewer.scene.canvas.style.cursor = 'default';
        }
        return;
      }
      const now = performance.now();
      if (now - lastPick < HOVER_THROTTLE_MS) return;
      lastPick = now;
      const tag = pickTag(
        viewer.scene,
        movement.endPosition,
        roadsVisibleRef.current,
        false,
        modeRef.current !== 'city',
      );
      hoverCleared = tag === null;
      // Every hover target in one write: they are live at the same time and
      // separate writes would render the scene once each for a single move.
      setHover(
        tag?.kind === 'building' ? tag.id : null,
        tag?.kind === 'unit' ? tag.id : null,
        tag?.kind === 'road' ? tag.id : null,
      );
      viewer.scene.canvas.style.cursor = tag ? 'pointer' : 'default';
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const tag = pickTag(viewer.scene, click.position, roadsVisibleRef.current, true);
      if (!tag) {
        // Clicking bare ground drops the ambient selections -- street and
        // utility -- but NOT the building/floor/unit stack. See clearAmbient
        // in lib/store.ts for why the distinction matters.
        clearAmbient();
        return;
      }
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
        case 'road':
          // No camera move, deliberately. A street spans the AOI, so "frame
          // the road" means zooming out to the whole neighbourhood -- and the
          // user selected it to read its attributes, not to travel to it. This
          // follows the utility precedent: selectedUtilityId is likewise absent
          // from CameraDirector's dependencies.
          selectRoad(tag.id);
          break;
        default:
          break;
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      setHover(null, null, null);
      if (!handler.isDestroyed()) handler.destroy();
    };
  }, [viewer, ready, selectBuilding, isolateFloor, selectUnit, openUnit,
      selectUtility, setHover]);

  return null;
}
