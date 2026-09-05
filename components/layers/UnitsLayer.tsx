'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useEnsureDetail, useViewStore } from '@/lib/store';
import { FLOOR_VIEW, MATERIALS } from '@/lib/cesium/materials';
import { liftFor } from '@/lib/cesium/explode';
import { sectionedRing } from '@/lib/cesium/section';
import { tagEntity } from '@/lib/cesium/tag';
import { toSceneZ } from '@/lib/cesium/terrain';
import { insetRing, ringCentroid, slicePlane, type HalfPlane } from '@/lib/geo';
import type { Mode } from '@/lib/types';

/**
 * Unit volumes -- the individual flats.
 *
 * They are CO-VISIBLE with their floor, not a level below it. On an isolated
 * floor the level is drawn as a thin plate plus a translucent height shell (see
 * FloorStackLayer) and every flat on it stands on that plate as its own solid
 * box, individually hoverable and pickable. Selecting one does not take the
 * others away; they dim.
 *
 * TWO THINGS KEEP THE FLATS VISIBLE. The floor's own volume is drawn at
 * FLOOR_VIEW.SHELL_ALPHA rather than solid, and each flat is pulled
 * FLOOR_VIEW.UNIT_INSET_M in from its stored footprint and lifted
 * FLOOR_VIEW.UNIT_LIFT_M off the plate. The inset is what gives adjacent flats
 * a seam instead of a shared, z-fighting wall -- units are a grid subdivision,
 * so neighbours literally share wall lines in the DB. It is applied HERE, at
 * render time: the stored geometry, the API and the ULPINs are untouched.
 *
 * ENTITY LIFETIME. Every unit of the active building is built once on entry, as
 * BuildingsLayer does with its 384 footprints -- at most ~27 flats for the
 * tallest block here. Which of them are on screen, how bright they are and
 * where the section plane has cut them are CallbackProperty closures over a
 * single mutable ref, eased by one requestAnimationFrame loop. Nothing is
 * created or destroyed on a mode switch.
 */

interface UnitState {
  mode: Mode;
  isolated: number | null;
  selectedId: number | null;
  hoveredId: number | null;
  anySelected: boolean;
  explodeT: number;
  /** A section is being cut, so every level is drawn as a plate. */
  sliced: boolean;
  /** Eased 0-1 master opacity; see the rAF driver at the bottom. */
  fade: number;
  fadeTarget: number;
  /** Bumped whenever the section plane moves; see lib/cesium/section.ts. */
  sliceVersion: number;
  plane: HalfPlane | null;
}

/** Per frame, ~600 ms to settle. Matches BuildingsLayer's fade. */
const FADE_RATE = 0.12;

/**
 * Master opacity for the whole layer, given the current view.
 *
 * On an isolated floor the flats are the subject, so they are fully up. Under a
 * section they are fully up too: cutting a building open and leaving the flats
 * out of the cut is not a section of anything worth looking at.
 *
 * On the exploded stack in building mode they fade in across
 * EXPLODE_UNITS_IN..EXPLODE_UNITS_FULL: below that the storeys have not
 * separated far enough for a flat sitting on one to be legible, and popping
 * them in at a threshold reads as a glitch.
 */
function opacityFor(
  mode: Mode, isolated: number | null, explodeT: number, sliced: boolean,
  showFloors: boolean,
): number {
  if (!showFloors) return 0;
  if (sliced && mode !== 'city') return 1;
  if ((mode === 'floor' || mode === 'unit') && isolated !== null) return 1;
  if (mode === 'building') {
    const t = explodeT / 100;
    const { EXPLODE_UNITS_IN: lo, EXPLODE_UNITS_FULL: hi } = FLOOR_VIEW;
    if (t <= lo) return 0;
    return Math.min(1, (t - lo) / (hi - lo));
  }
  return 0;
}

export default function UnitsLayer() {
  const { viewer, ground, ready } = useViewer();
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const selectedUnitId = useViewStore((s) => s.selectedUnitId);
  const hoveredUnitId = useViewStore((s) => s.hoveredUnitId);
  const explodeT = useViewStore((s) => s.explodeT);
  const showFloors = useViewStore((s) => s.layers.floors);
  const slice = useViewStore((s) => s.slice);
  const buildings = useDataStore((s) => s.buildings);
  const detail = useEnsureDetail(mode === 'city' ? null : activeBuildingId);

  const stateRef = useRef<UnitState>({
    mode: 'city', isolated: null, selectedId: null, hoveredId: null,
    anySelected: false, explodeT: 0, sliced: false, fade: 0, fadeTarget: 0,
    sliceVersion: 0, plane: null,
  });
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  const footprint = buildings?.features.find(
    (f) => f.properties.id === activeBuildingId,
  );

  // ---- push store state into the render closure ----------------------------
  useEffect(() => {
    const s = stateRef.current;
    s.mode = mode;
    s.isolated = isolatedFloor;
    s.selectedId = selectedUnitId;
    s.hoveredId = hoveredUnitId;
    s.anySelected = selectedUnitId !== null;
    s.explodeT = explodeT;
    s.sliced = slice.enabled;
    s.fadeTarget = opacityFor(mode, isolatedFloor, explodeT, slice.enabled, showFloors);
  }, [mode, isolatedFloor, selectedUnitId, hoveredUnitId, explodeT,
      slice.enabled, showFloors]);

  // The section plane comes from the active footprint, so the flats are cut by
  // exactly the plane the floor plate and shell are cut by.
  useEffect(() => {
    const ring = footprint
      ? (footprint.geometry.coordinates as number[][][])[0]
      : null;
    stateRef.current.plane =
      slice.enabled && ring ? slicePlane(ring, slice.axis, slice.offset) : null;
    stateRef.current.sliceVersion += 1;
    if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
  }, [footprint, slice.enabled, slice.axis, slice.offset, viewer]);

  // ---- build every unit of the active building, once -----------------------
  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (!detail || activeBuildingId === null) return;
    const bprops = footprint?.properties;
    if (!bprops) return;

    const terrainH = ground.get(activeBuildingId);
    const ds = new Cesium.CustomDataSource('units');
    dsRef.current = ds;
    viewer.dataSources.add(ds);

    const readSection = () => ({
      version: stateRef.current.sliceVersion,
      plane: stateRef.current.plane,
    });

    const floors = [...detail.floors].sort((a, b) => a.level_no - b.level_no);
    const byLevel = new Map(floors.map((f, i) => [f.level_no, { f, index: i }]));

    /**
     * Each flat's slot on its own plate, so neighbours never share a tint.
     *
     * Keyed on the unit code rather than on iteration order: the code is what
     * is written on the door and what the citizen's session names, so a flat
     * keeps its colour across a re-seed that happens to reorder the array.
     */
    const slotOf = new Map<number, number>();
    for (const f of floors) {
      const onFloor = detail.units
        .filter((u) => u.level_no === f.level_no)
        .sort((a, b) => a.unit_no.localeCompare(b.unit_no, 'en'));
      onFloor.forEach((u, i) => slotOf.set(u.id, i));
    }

    for (const unit of detail.units) {
      const entry = byLevel.get(unit.level_no);
      if (!entry) continue;                    // a unit with no floor record
      const stored = (unit.ring.coordinates as number[][][])[0];
      if (stored.length < 4) continue;

      const ring = insetRing(stored, FLOOR_VIEW.UNIT_INSET_M);
      const level = unit.level_no;
      const uid = unit.id;
      const slot = slotOf.get(uid) ?? 0;
      // The signed-in citizen's own flat. Matched on (level, code) because
      // that is what the session carries -- see ownsUnit in lib/auth.
      const sess = useViewStore.getState().session;
      const isOwn = sess.role === 'citizen'
        && sess.floor === unit.level_no
        && sess.unit === unit.unit_no;

      const floorZ0 = toSceneZ(entry.f.z_min, bprops.ground_elev, terrainH);
      const floorZ1 = toSceneZ(entry.f.z_max, bprops.ground_elev, terrainH);
      const unitZ1 = toSceneZ(unit.z_max, bprops.ground_elev, terrainH);

      // On the plate: clear of it by UNIT_LIFT_M so the seam under the flat is
      // visible and the two surfaces cannot z-fight.
      const onPlate = floorZ0 + FLOOR_VIEW.PLATE_THICKNESS_M + FLOOR_VIEW.UNIT_LIFT_M;
      const boxHeight = Math.max(FLOOR_VIEW.UNIT_MIN_HEIGHT_M, unitZ1 - onPlate);

      /**
       * Where this flat's base sits, and how far it rides the explode slider.
       *
       * Two anchors, because the flats sit on two different things.
       *
       * On the exploded stack in building mode the level is a solid storey
       * block drawn by BuildingModelLayer, so the flats stand on its TOP face
       * -- inside it they would be behind an opaque textured wall -- and they
       * take that layer's lift, which is indexed by level_no.
       *
       * Everywhere else the level is a thin base plate and the flats stand on
       * it: on an isolated floor, and on every level at once under a section,
       * where FloorStackLayer collapses the whole stack to plates for exactly
       * this reason. There they ride FloorStackLayer's lift, which is indexed
       * by position in the sorted floor array (basements first).
       */
      const baseZ = (): number => {
        const s = stateRef.current;
        if (s.mode === 'building' && !s.sliced) {
          return floorZ1 + FLOOR_VIEW.UNIT_LIFT_M + liftFor(level, s.explodeT);
        }
        return onPlate + liftFor(entry.index, s.explodeT);
      };

      const section = sectionedRing(ring, readSection);

      /** Opacity of THIS flat right now: the layer's fade, then the dim. */
      const alpha = (): number => {
        const s = stateRef.current;
        const base = s.anySelected && s.selectedId !== uid
          ? FLOOR_VIEW.UNIT_DIM_ALPHA          // dimmed, never hidden
          : FLOOR_VIEW.UNIT_ALPHA;
        return base * s.fade;
      };

      const onScreen = (): boolean => {
        const s = stateRef.current;
        if (s.fade <= 0.02) return false;
        // A section shows every above-ground level's flats at once; so does the
        // exploded stack. Basement flats stay inside the grey below-grade mass,
        // which is drawn solid and does not lift.
        if (s.mode === 'building' || (s.sliced && s.isolated === null)) {
          return level >= 0;
        }
        return s.isolated === level;
      };

      const centre = ringCentroid(ring);

      const entity = ds.entities.add({
        // Carried for the label; the polygon has its own hierarchy.
        position: new Cesium.CallbackProperty(
          () => Cesium.Cartesian3.fromDegrees(
            centre.lon, centre.lat, baseZ() + boxHeight * 0.5,
          ),
          false,
        ) as unknown as Cesium.PositionProperty,
        polygon: {
          hierarchy: section.hierarchy,
          height: new Cesium.CallbackProperty(baseZ, false),
          extrudedHeight: new Cesium.CallbackProperty(() => baseZ() + boxHeight, false),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const s = stateRef.current;
              const a = alpha();
              // Own flat first: for a citizen this is the one thing on screen
              // that has to stay findable, including while something else is
              // selected and it is being dimmed.
              if (isOwn) return MATERIALS.unitOwn(a);
              // A flat that cannot be opened does not offer itself: no tint of
              // its own, no hover response. It is massing, so the floor reads
              // as a real floor and the citizen's own flat reads as the one
              // thing on it that is theirs.
              if (unit.restricted) return MATERIALS.unitRestricted(a);
              if (s.selectedId === uid) return MATERIALS.unitSelected(a);
              if (s.hoveredId === uid) return MATERIALS.unitHover(a);
              return MATERIALS.unitTint(slot, a);
            }, false),
          ),
          // The selected unit gets a silhouette outline, so it reads as chosen
          // even where it is occluded by neighbouring units.
          outline: true,
          outlineWidth: 2,
          outlineColor: new Cesium.CallbackProperty(
            () => {
              if (isOwn) return MATERIALS.unitOwnOutline;
              return stateRef.current.selectedId === uid
                ? MATERIALS.unitOutline
                : MATERIALS.unitOutlineIdle;
            },
            false,
          ),
          shadows: Cesium.ShadowMode.DISABLED,
          show: new Cesium.CallbackProperty(
            () => onScreen() && section.survives(),
            false,
          ),
        },
        label: {
          text: unit.unit_no,
          font: '600 12px ui-sans-serif, system-ui, sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: MATERIALS.unitLabelFill,
          outlineColor: MATERIALS.unitLabelOutline,
          outlineWidth: 3,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Declutter: past this the flats are a few pixels across and their
          // codes are a smear. Enforced by Cesium against the label's own
          // position, so it costs nothing per frame.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0, FLOOR_VIEW.LABEL_MAX_DISTANCE_M,
          ),
          // The flats sit inside a translucent shell; without this the codes
          // disappear behind it at grazing angles.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(() => {
            const s = stateRef.current;
            if (!onScreen() || !section.survives()) return false;
            // Every code on an isolated floor; on the exploded stack only the
            // flat under the cursor, or 27 codes fight for the same pixels.
            return s.mode !== 'building' || s.hoveredId === uid;
          }, false),
        },
      });
      // A restricted flat is deliberately left UNTAGGED.
      //
      // Picker resolves a click through the tag, so an untagged volume is not
      // a unit as far as the pick is concerned and the drill falls through to
      // the floor beneath it. That is the behaviour wanted: a citizen can
      // click their own floor and inspect it, and clicking a neighbour's flat
      // selects the floor rather than the flat. No "you may not open this"
      // dialog, because there is nothing there to open.
      //
      // Selection is defended twice over regardless: the neighbour arrives
      // with no registry data, so there is nothing for the panel to show even
      // if a selection did somehow land on it.
      if (!unit.restricted) {
        // `level` travels with the tag so a click on the exploded stack can
        // isolate the floor and select the flat in ONE store write.
        tagEntity(entity, { kind: 'unit', id: uid, level });
      }
    }

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, ground, detail, activeBuildingId, footprint]);

  // ---- one animation driver for the whole layer ---------------------------
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const s = stateRef.current;
      const delta = s.fadeTarget - s.fade;
      if (Math.abs(delta) > 0.002) {
        s.fade += delta * FADE_RATE;
        // The scene renders on demand, so an eased value that nothing else is
        // touching needs to ask for the frames it is animating over.
        if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
      } else if (s.fade !== s.fadeTarget) {
        s.fade = s.fadeTarget;
        if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [viewer]);

  return null;
}
