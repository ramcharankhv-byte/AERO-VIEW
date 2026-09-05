'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect } from 'react';
import { useViewer } from './CesiumRoot';
import { useActiveDetail, useDataStore, useViewStore } from '@/lib/store';
import { toSceneZ } from '@/lib/cesium/terrain';
import { frameHeightFor } from '@/lib/cesium/setup';
import { ringCentreWithRadius } from '@/lib/geo';

/**
 * ALL camera movement in the application lives here.
 *
 * ARCHITECTURE RULE: no other component calls flyTo, flyToBoundingSphere,
 * zoomTo, lookAt or setView. This component watches the store and choreographs
 * the transition for whatever state it finds. That keeps the four view modes
 * from fighting each other over the camera, which is the usual failure mode of
 * a multi-mode 3D scene.
 *
 * (CesiumRoot performs a single setView at construction to frame the AOI. That
 * is the scene's initial pose, not a transition.)
 */

const FLY_MS = 1.5;

/** Position the camera so it looks down at (lon, lat, groundZ) with a pitch. */
function poseFor(
  lon: number,
  lat: number,
  groundZ: number,
  heightAbove: number,
  pitchDeg: number,
  headingDeg = 0,
): { destination: Cesium.Cartesian3; orientation: Cesium.HeadingPitchRollValues } {
  const pitch = Cesium.Math.toRadians(pitchDeg);
  const heading = Cesium.Math.toRadians(headingDeg);
  // Horizontal standoff needed to achieve the pitch from this height.
  const standoff = heightAbove / Math.tan(Math.abs(pitch));
  const dLat = (standoff * Math.cos(heading)) / 110574;
  const dLon =
    (standoff * Math.sin(heading)) / (111320 * Math.cos(Cesium.Math.toRadians(lat)));
  return {
    destination: Cesium.Cartesian3.fromDegrees(
      lon - dLon,
      lat - dLat,
      groundZ + heightAbove,
    ),
    orientation: { heading, pitch, roll: 0 },
  };
}

/**
 * The one gate every camera destination in this file passes through.
 *
 * Cesium has no tolerance for a non-finite pose. A single NaN reaching
 * camera.position does not spoil one frame -- Scene.updateFrameState calls
 * frustum.computeCullingVolume(positionWC, directionWC, upWC), which
 * normalises the cross product of a NaN basis and throws
 *
 *   DeveloperError: normalized result is not a number
 *
 * on EVERY subsequent frame, because the bad position is now the camera's
 * state. So one missing height_m, one terrain sample that never landed, or
 * one degenerate footprint permanently kills the renderer instead of costing
 * a single flight.
 *
 * Refusing the flight leaves the camera exactly where it is, which is by
 * construction a pose Cesium already accepted.
 */
function flyToPose(
  camera: Cesium.Camera,
  pose: { destination: Cesium.Cartesian3; orientation: Cesium.HeadingPitchRollValues },
): void {
  const { destination: d, orientation: o } = pose;
  if (
    !Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.z)
    || !Number.isFinite(o.heading) || !Number.isFinite(o.pitch)
    || !Number.isFinite(o.roll)
  ) {
    console.warn('[camera] refused a non-finite pose', pose);
    return;
  }
  camera.flyTo({ ...pose, duration: FLY_MS });
}

export default function CameraDirector() {
  const { viewer, ground, ready, project } = useViewer();
  // The project's own centre, not a module constant. Pressing Reset on a
  // Hyderabad project used to fly the camera to Visakhapatnam.
  const aoiCentre = project
    ? { lon: (project.bbox[0] + project.bbox[2]) / 2,
        lat: (project.bbox[1] + project.bbox[3]) / 2 }
    : { lon: 0, lat: 0 };
  const cityHeight = project ? frameHeightFor(project.bbox) : 1200;
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const selectedUnitId = useViewStore((s) => s.selectedUnitId);
  const underground = useViewStore((s) => s.underground);
  const buildings = useDataStore((s) => s.buildings);
  const detail = useActiveDetail();

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return;
    const camera = viewer.camera;

    // ---- UNDERGROUND -----------------------------------------------------
    // Shallow pitch so the eye travels along the corridors rather than looking
    // straight down onto them.
    //
    // Height matters here: a water main is 0.25 m in radius, so from a city-wide
    // vantage the corridors are sub-pixel and the mode looks empty. We drop in
    // close -- tighter still when a building is active, since that is the
    // basement whose conflict the user is most likely chasing.
    if (underground) {
      const target = (() => {
        if (activeBuildingId != null && buildings) {
          const f = buildings.features.find((x) => x.properties.id === activeBuildingId);
          if (f) {
            const c = ringCentreWithRadius((f.geometry.coordinates as number[][][])[0]);
            return { lon: c.lon, lat: c.lat, height: 70 };
          }
        }
        return { ...aoiCentre, height: 130 };
      })();
      flyToPose(camera, poseFor(target.lon, target.lat, 0, target.height, -18));
      return;
    }

    // ---- CITY ------------------------------------------------------------
    if (mode === 'city' || activeBuildingId == null) {
      // Matches frameInitialCamera's height/heading/pitch, so Reset returns to
      // the pose the scene opened on rather than a subtly different one. Both
      // read the height from the same frameHeightFor(bbox).
      flyToPose(camera, poseFor(aoiCentre.lon, aoiCentre.lat, 0, cityHeight, -55, 35));
      return;
    }

    if (!buildings) return;
    const feature = buildings.features.find((f) => f.properties.id === activeBuildingId);
    if (!feature) return;

    const ring = (feature.geometry.coordinates as number[][][])[0];
    const { lon, lat, radius } = ringCentreWithRadius(ring);
    const props = feature.properties;
    const terrainH = ground.get(props.id);
    const baseZ = toSceneZ(props.ground_elev, props.ground_elev, terrainH);

    // ---- UNIT ------------------------------------------------------------
    if (mode === 'unit' && selectedUnitId != null && detail) {
      const unit = detail.units.find((u) => u.id === selectedUnitId);
      if (unit) {
        const uc = ringCentreWithRadius((unit.ring.coordinates as number[][][])[0]);
        const z = toSceneZ((unit.z_min + unit.z_max) / 2, props.ground_elev, terrainH);
        flyToPose(camera, poseFor(uc.lon, uc.lat, z, Math.max(28, uc.radius * 2.2), -24));
        return;
      }
    }

    // ---- FLOOR -----------------------------------------------------------
    // Drop to the level and look across it, nearly level with the slab.
    if (mode === 'floor' && isolatedFloor != null && detail) {
      const fl = detail.floors.find((f) => f.level_no === isolatedFloor);
      const z = fl
        ? toSceneZ((fl.z_min + fl.z_max) / 2, props.ground_elev, terrainH)
        : baseZ;
      flyToPose(camera, poseFor(lon, lat, z, Math.max(34, radius * 1.6), -16));
      return;
    }

    // ---- BUILDING --------------------------------------------------------
    // 1.5 s flight to a bounding sphere with an orbit offset, as specified.
    const topZ = baseZ + props.height_m;
    const centre = Cesium.Cartesian3.fromDegrees(lon, lat, (baseZ + topZ) / 2);
    const sphereRadius = Math.max(radius, props.height_m * 0.6, 18);
    // Same gate as flyToPose, for the one destination that is a sphere rather
    // than a pose: a null height_m or an unsampled terrain height would put a
    // NaN centre or radius into the camera and throw on every frame after.
    if (
      !Number.isFinite(centre.x) || !Number.isFinite(centre.y)
      || !Number.isFinite(centre.z) || !Number.isFinite(sphereRadius)
    ) {
      console.warn('[camera] refused a non-finite bounding sphere', {
        id: props.id, centre, sphereRadius,
      });
      return;
    }
    camera.flyToBoundingSphere(new Cesium.BoundingSphere(centre, sphereRadius), {
      duration: FLY_MS,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(35),
        Cesium.Math.toRadians(-28),
        sphereRadius * 3.4,
      ),
    });
  }, [
    viewer, ready, ground, mode, activeBuildingId, isolatedFloor,
    selectedUnitId, underground, buildings, detail,
  ]);

  // Auto-spin is camera motion, so it is owned here too rather than by the
  // NavDock button that switches it on.
  const autoSpin = useViewStore((s) => s.autoSpin);
  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed() || !autoSpin) return;
    const onTick = () => {
      if (viewer.isDestroyed()) return;
      viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -Cesium.Math.toRadians(0.06));
    };
    viewer.clock.onTick.addEventListener(onTick);
    return () => {
      if (!viewer.isDestroyed()) viewer.clock.onTick.removeEventListener(onTick);
    };
  }, [viewer, ready, autoSpin]);

  return null;
}
