'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { MATERIALS } from '@/lib/cesium/materials';
import { toSceneZ } from '@/lib/cesium/terrain';
import { flatLonLat } from '@/lib/geo';
import { buildRoof } from '@/lib/cesium/roofs';
import { fixturesFor } from '@/lib/cesium/equipment';
import { ringPerimeterM } from '@/lib/geo';
import { windowGrid } from '@/lib/cesium/textures';
import type { BuildingProps, UseType } from '@/lib/types';

/**
 * The architectural model of the active building.
 *
 * Replaces the simple extruded prism with a per-storey stack of:
 *   - wall extrusions carrying a per-use-type window-grid texture (the ground
 *     storey takes a variant with an entry door),
 *   - a flat slab cap closing every storey's top,
 *   - floor bands at every slab line,
 *   - a flat parapet roof,
 *   - rooftop fixtures (water tank, AC units, flagpole, cowls).
 *
 * Explode: each storey is its OWN entity whose height/extrudedHeight are
 * CallbackProperties reading a shared mutable ref. Dragging the slider
 * separates the storeys at frame rate without rebuilding any geometry --
 * one animation driver for the whole model. The roof and fixtures ride on
 * whichever storey is currently topmost.
 *
 * Only one building is ever modelled. On deselect, the layer tears itself
 * down and the city view reverts to the 384 prisms drawn by BuildingsLayer.
 * BuildingsLayer's `hideActive` already hides the active prism while a model
 * is up, so the two layers never overlap on screen.
 */

const FLOOR_H = 3.2;

interface ModelState {
  explodeT: number;
}

export default function BuildingModelLayer() {
  const { viewer, ground, ready } = useViewer();
  const buildings = useDataStore((s) => s.buildings);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const mode = useViewStore((s) => s.mode);
  const explodeT = useViewStore((s) => s.explodeT);
  const sunHour = useViewStore((s) => s.sunHour);
  const sliceEnabled = useViewStore((s) => s.slice.enabled);

  const stateRef = useRef<ModelState>({ explodeT: 0 });
  /** Shared shadow mode -- see the note in BuildingsLayer. */
  const shadowsRef = useRef(new Cesium.ConstantProperty(Cesium.ShadowMode.DISABLED));
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  useEffect(() => {
    stateRef.current.explodeT = explodeT;
  }, [explodeT]);

  useEffect(() => {
    shadowsRef.current.setValue(
      sunHour === null ? Cesium.ShadowMode.DISABLED : Cesium.ShadowMode.ENABLED,
    );
    if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
  }, [sunHour, viewer]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    if (!buildings || activeBuildingId === null || mode !== 'building' || sliceEnabled) {
      // Deselect, or the user drilled into a floor/unit: the slab stack drawn
      // by FloorStackLayer takes over, and this model would sit on top of it
      // occluding the isolated-floor highlight. Tear down if we still have a
      // model up.
      //
      // Slicing in building mode is the same story for a different reason. The
      // section is cut on the CPU against entity RINGS (see lib/cesium/section)
      // and these storey walls are opaque and textured, so leaving them up
      // would hide the very cut the user asked for behind an uncut box. The
      // slab stack, which the section does reach, takes over instead.
      if (dsRef.current && !viewer.isDestroyed()) {
        viewer.dataSources.remove(dsRef.current, true);
        dsRef.current = null;
      }
      return;
    }

    const feat = buildings.features.find(
      (f) => f.properties.id === activeBuildingId,
    );
    if (!feat) return;
    const props = feat.properties as BuildingProps;
    const ring = (feat.geometry.coordinates as number[][][])[0];
    if (ring.length < 4) return;

    const use = props.use_type as UseType;
    const flat = flatLonLat(ring);
    if (flat.length < 6) return;

    const terrainH = ground.get(activeBuildingId);
    const base = toSceneZ(props.ground_elev, props.ground_elev, terrainH);
    const fullTop = base + Math.max(2, props.height_m);

    // Explode lift for an above-ground storey (0-indexed). Matches
    // FloorStackLayer's easing so the model and the slab view agree.
    const liftFor = (storeyIndex: number): number => {
      const t = Math.min(1, Math.max(0, stateRef.current.explodeT / 100));
      if (t <= 0) return 0;
      const eased = 1 - Math.pow(1 - t, 3);
      return storeyIndex * 3.4 * eased;
    };

    // Build a fresh data source so previous selections are fully released.
    const ds = new Cesium.CustomDataSource('building-model');
    viewer.dataSources.add(ds);
    dsRef.current = ds;

    // ---- walls: one extruded, textured storey per level ------------------
    // A narrower wall tile (one bay per 3 m, not 4) so the model reads with
    // finer fenestration rhythm than the city-scale extrusions. Storey 0
    // takes a ground-floor variant whose bay carries an entry door.
    //
    // Without an explicit repeat an ImageMaterialProperty tiles (1,1): one
    // 3 m bay stretched around the whole perimeter per storey, which read as
    // a plain block. The walls are WallGraphics (like the city layer) whose
    // u is the ring's cumulative arc length, so repeating the tile
    // perimeter/3 times lays one real bay per 3 m on every wall. v spans
    // exactly one storey -- the tile is drawn for one -- so repeat.y stays 1.
    const baysPerimeter = Math.max(1, Math.round(ringPerimeterM(ring) / 3));
    const wallTexture = new Cesium.ImageMaterialProperty({
      image: windowGrid(use, 3, FLOOR_H),
      repeat: new Cesium.Cartesian2(baysPerimeter, 1),
      color: Cesium.Color.WHITE,
    });
    const groundTexture = new Cesium.ImageMaterialProperty({
      image: windowGrid(use, 3, FLOOR_H, true),
      repeat: new Cesium.Cartesian2(baysPerimeter, 1),
      color: Cesium.Color.WHITE,
    });

    // Above-ground storeys 0..floors-1, then any basements as a solid grey
    // mass below grade. Each storey lifts by its own index when exploded --
    // via callback-driven minimum/maximumHeights, the same dynamic-geometry
    // path the old extruded polygons used. A flat slab cap closes each
    // storey's top: a wall has no top face, but an exploded stack would
    // otherwise show straight through between storeys, so the caps read as
    // the floor plates.
    const storeyCount = Math.max(1, props.floors);
    for (let i = 0; i < storeyCount; i++) {
      const z0 = base + i * FLOOR_H;
      const positions = Cesium.Cartesian3.fromDegreesArrayHeights(
        flat.flatMap((v, idx) => (idx % 2 === 0 ? [v, flat[idx + 1], z0] : [])),
      );
      ds.entities.add({
        wall: {
          positions,
          minimumHeights: new Cesium.CallbackProperty(
            () => positions.map(() => z0 + liftFor(i)),
            false,
          ) as unknown as Cesium.Property,
          maximumHeights: new Cesium.CallbackProperty(
            () => positions.map(() => z0 + FLOOR_H + liftFor(i)),
            false,
          ) as unknown as Cesium.Property,
          material: i === 0 ? groundTexture : wallTexture,
          outline: true,
          outlineColor: MATERIALS.buildingModelRoofLine,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      // Slab cap riding the same lift: a hair above the storey top, thin
      // enough not to z-fight, light enough to read as a floor plate.
      ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: new Cesium.CallbackProperty(
            () => z0 + FLOOR_H + liftFor(i) - 0.1,
            false,
          ),
          extrudedHeight: new Cesium.CallbackProperty(
            () => z0 + FLOOR_H + liftFor(i) + 0.02,
            false,
          ),
          material: MATERIALS.buildingModelSlabCap,
          outline: false,
          shadows: shadowsRef.current,
        },
      });
    }
    for (let b = 1; b <= props.basements; b++) {
      const z0 = base - b * FLOOR_H;
      ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
          height: z0,
          extrudedHeight: z0 + FLOOR_H,
          // Basements are below grade: solid grey mass, and they stay put
          // when the above-ground storeys lift.
          material: MATERIALS.basementSlab,
          outline: false,
          shadows: shadowsRef.current,
        },
      });
    }

    // ---- floor bands: a horizontal line at every slab line ---------------
    // Drawn at the SEAM between storeys (i.e. at each storey's top minus a
    // hair) rather than at fixed heights, so they ride with the storeys and
    // always sit on a wall, never floating over an exploded gap.
    const bandMat = new Cesium.ColorMaterialProperty(MATERIALS.buildingModelFixture);
    const ringFlat: number[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      ringFlat.push(flat[i], flat[i + 1]);
    }
    for (let i = 1; i < storeyCount; i++) {
      const positions: number[] = [];
      for (let v = 0; v < ringFlat.length; v += 2) {
        positions.push(ringFlat[v], ringFlat[v + 1], 0);
      }
      ds.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            const lift = liftFor(i);
            const out: number[] = [];
            for (let v = 0; v < positions.length; v += 3) {
              out.push(positions[v], positions[v + 1], z0ForBand(i) + lift);
            }
            return Cesium.Cartesian3.fromDegreesArrayHeights(out);
          }, false) as unknown as Cesium.PositionProperty,
          width: 1.2,
          material: bandMat,
          clampToGround: false,
        },
      });
    }
    // Bands sit at the top of storey i-1: base + i*FLOOR_H.
    function z0ForBand(i: number): number {
      return base + i * FLOOR_H;
    }

    // ---- ground plinth: a 0.3 m apron around the footprint ---------------
    // Grounds the model against the parcel surface so it stops reading as a
    // cake topper. Static (never lifts) — it is the one part that stays.
    {
      const n = Math.max(1, ring.length - 1);
      let cx = 0, cy = 0;
      for (let i = 0; i < n; i++) { cx += ring[i][0]; cy += ring[i][1]; }
      cx /= n; cy /= n;
      const mPerDegLat = 110574;
      const mPerDegLon = 111320 * Math.cos((cy * Math.PI) / 180);
      const apron: number[] = [];
      for (let i = 0; i < n; i++) {
        const lon = ring[i][0];
        const lat = ring[i][1];
        const dx = (lon - cx) * mPerDegLon;
        const dy = (lat - cy) * mPerDegLat;
        const d = Math.hypot(dx, dy);
        if (d < 0.4) {
          apron.push(lon, lat);
        } else {
          apron.push(cx + ((lon - cx) * (d + 1.2)) / d, cy + ((lat - cy) * (d + 1.2)) / d);
        }
      }
      ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(apron)),
          height: base - 0.25,
          extrudedHeight: base,
          material: MATERIALS.buildingModelPlinth,
          outline: false,
          shadows: shadowsRef.current,
        },
      });
    }

    // ---- roof + fixtures: rebuilt when the top storey changes ------------
    // A gabled/hipped roof is baked geometry; translating it with the top
    // storey would need per-frame vertex rewrites, which Cesium entities do
    // not support cheaply. So the roof is positioned by the lift the model
    // has RIGHT NOW and rebuilt if the explode slider moves far enough to
    // change the top storey's offset. In practice the explode gesture is
    // short, and rebuilding a handful of polygons is cheap.
    const roofAnchor = { lift: liftFor(storeyCount - 1) };
    let roofEntities: Cesium.Entity[] = [];
    let fixtures: Cesium.Entity[] = [];

    const addRoofAndFixtures = (topLift: number) => {
      const roof = buildRoof(use, ring, base + topLift, props.height_m);
      const roofColor = new Cesium.ColorMaterialProperty(MATERIALS.buildingModelRoof(use));
      const wallColor = new Cesium.ColorMaterialProperty(MATERIALS.buildingModelWall);
      for (const face of roof.faces) {
        // Per-position heights are essential here: a pitched profile baked
        // into a constant-height polygon flattens to a plate.
        const flatH: number[] = [];
        for (const [lon, lat, z] of face) flatH.push(lon, lat, z);
        const e = ds.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArrayHeights(flatH),
            ),
            perPositionHeight: true,
            material: roofColor,
            outline: false,
            shadows: shadowsRef.current,
          },
        });
        roofEntities.push(e);
      }
      // Gable ends are wall, not roof -- drawing them in the roof colour made
      // every residential roof read as if it had been painted on.
      for (const face of roof.wallFaces) {
        const flatH: number[] = [];
        for (const [lon, lat, z] of face) flatH.push(lon, lat, z);
        const e = ds.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArrayHeights(flatH),
            ),
            perPositionHeight: true,
            material: wallColor,
            outline: false,
            shadows: shadowsRef.current,
          },
        });
        roofEntities.push(e);
      }

      const fs = fixturesFor(use, ring, base + topLift, props.height_m);
      for (const f of fs) {
        ds.entities.add(f);
        fixtures.push(f);
      }
    };

    addRoofAndFixtures(roofAnchor.lift);

    // Re-emit roof/fixtures when the top storey's lift has drifted far
    // enough from where the current roof was baked.
    const stopRoofSync = watchRefValue(
      () => liftFor(storeyCount - 1),
      roofAnchor,
      () => {
        for (const e of roofEntities) ds.entities.remove(e);
        for (const f of fixtures) ds.entities.remove(f);
        roofEntities = [];
        fixtures = [];
        addRoofAndFixtures(roofAnchor.lift);
      },
      viewer,
    );

    // ---- cornice + parapet: thin ring at the top of the walls ------------
    // Follows the top storey's lift via CallbackProperty (constant profile,
    // so a callback CAN drive it).
    const inset: number[] = (() => {
      const n = Math.max(1, ring.length - 1);
      let x = 0, y = 0;
      for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
      const cLon = x / n, cLat = y / n;
      const mPerDegLat = 110574;
      const mPerDegLon = 111320 * Math.cos((cLat * Math.PI) / 180);
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const lon = ring[i][0];
        const lat = ring[i][1];
        const dx = (lon - cLon) * mPerDegLon;
        const dy = (lat - cLat) * mPerDegLat;
        const d = Math.hypot(dx, dy);
        if (d < 0.4) {
          out.push(lon, lat);
        } else {
          out.push(
            cLon + ((lon - cLon) * (d - 0.3)) / d,
            cLat + ((lat - cLat) * (d - 0.3)) / d,
          );
        }
      }
      return out;
    })();

    // A storey whose height is driven by callbacks can't take a separate
    // "cornice extrusion" without z-fighting the wall; a band polyline at
    // the cornice line reads the same at this scale and rides the lift.
    const topIndex = storeyCount - 1;
    const topPos: number[] = [];
    for (let v = 0; v < inset.length; v += 2) topPos.push(inset[v], inset[v + 1], 0);
    ds.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const lift = liftFor(topIndex);
          const out: number[] = [];
          for (let v = 0; v < topPos.length; v += 3) {
            out.push(topPos[v], topPos[v + 1], fullTop + lift);
          }
          return Cesium.Cartesian3.fromDegreesArrayHeights(out);
        }, false) as unknown as Cesium.PositionProperty,
        width: 2,
        material: bandMat,
        clampToGround: false,
      },
    });

    // ---- selection highlight: polyline along the top of the wall ---------
    // Stays visible even when the floor stack is occluding the walls.
    ds.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const lift = liftFor(topIndex);
          const out: number[] = [];
          for (let i = 0; i < flat.length; i += 2) {
            out.push(flat[i], flat[i + 1], fullTop + lift + 0.05);
          }
          return Cesium.Cartesian3.fromDegreesArrayHeights(out);
        }, false) as unknown as Cesium.PositionProperty,
        width: 2,
        material: MATERIALS.unitOutline,
        clampToGround: false,
      },
    });

    return () => {
      stopRoofSync();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, ground, buildings, activeBuildingId, mode, sliceEnabled]);

  return null;
}
/**
 * Poll a ref-driven value on each frame and invoke `onChange` when it has
 * moved more than `tol` from the last baked value. Used to re-bake the roof
 * when the explode slider moves the top storey. A postRender listener keeps
 * this tied to the scene's frame budget rather than an independent rAF.
 */
function watchRefValue(
  read: () => number,
  anchor: { lift: number },
  onChange: () => void,
  viewer: Cesium.Viewer,
): () => void {
  const onFrame = () => {
    if (viewer.isDestroyed()) return;
    const v = read();
    if (Math.abs(v - anchor.lift) > 0.35) {
      anchor.lift = v;
      onChange();
    }
  };
  viewer.scene.postRender.addEventListener(onFrame);
  return () => {
    if (!viewer.isDestroyed()) viewer.scene.postRender.removeEventListener(onFrame);
  };
}
