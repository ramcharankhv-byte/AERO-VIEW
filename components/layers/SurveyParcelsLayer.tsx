'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useEnsureSurveyParcels, useViewStore } from '@/lib/store';
import { MATERIALS, SURVEY_PARCEL_VIEW } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import { createBucketGrid, extentOf } from '@/lib/cesium/spatial-buckets';
import { flatLonLat, ringPoleOfInaccessibility } from '@/lib/geo';
import type { SurveyParcelProps } from '@/lib/types';

/**
 * The 2D GIS cadastral layer: parcel boundaries and parcel numbers, drawn flat
 * on the ground, in place of the 3D stack.
 *
 * WHAT THESE BOUNDARIES ARE. Unless an official register has been imported,
 * every one of them is DERIVED -- a Voronoi cell around a cluster of OSM
 * footprints, clipped to the road corridors (scripts/survey_parcels.sql). The
 * number drawn inside it is a per-project ordinal, not a survey number, not a
 * TS number and not a Bhu-Aadhaar. The DetailPanel, the StatusBar and the
 * Legend all say so in words, because a numbered polygon on a flat map is
 * exactly what a cadastral sheet looks like and the resemblance is the risk.
 *
 * OUTLINE ONLY, IN TWO ENTITIES. Cesium cannot outline a ground-clamped
 * polygon -- it disables the outline and warns every frame -- so the boundary
 * is a separate `clampToGround` polyline, which is the supported path and the
 * one ParcelsLayer already uses. The polygon underneath it carries a 6% fill:
 * a ground-classified polygon is what makes the plot PICKABLE across its whole
 * area, and at that alpha it also gives the hover something to read against.
 *
 * ONE REF, ONE rAF LOOP. Hover and selection are CallbackProperty closures
 * over a single mutable ref, eased by one requestAnimationFrame loop for the
 * whole layer, which is the BuildingsLayer idiom. The callbacks are on the
 * POLYLINE material and width, not on the polygon fill: at most one parcel is
 * hovered and one selected, so putting a callback on 326 fills would be 324
 * per-frame closures computing "no" -- the precise cost ParcelsLayer had
 * removed from it.
 */

/** Ease rate for the fade-in, per frame. Matches BuildingsLayer's FADE_RATE. */
const FADE_RATE = 0.12;

interface LayerState {
  activeId: number | null;
  hoveredId: number | null;
  fade: number;
  fadeTarget: number;
}

export default function SurveyParcelsLayer() {
  const { viewer, ready } = useViewer();
  const gis2d = useViewStore((s) => s.gis2d);
  const parcels = useEnsureSurveyParcels(gis2d);
  const activeId = useViewStore((s) => s.activeSurveyParcelId);
  const hoveredId = useViewStore((s) => s.hoveredSurveyParcelId);

  const stateRef = useRef<LayerState>({
    activeId: null, hoveredId: null, fade: 0, fadeTarget: 0,
  });

  /**
   * The live visibility, readable from inside the build.
   *
   * A bucket is created on first use, DURING the incremental build, which is
   * after the visibility effect below has swept the buckets that existed when
   * it ran. A bucket born after that sweep keeps Cesium's default `show: true`
   * and would draw parcel boundaries over the 3D scene. Same ref, same reason,
   * as ParcelsLayer's showRef and UtilitiesLayer's visibleRef.
   */
  const showRef = useRef(gis2d);
  showRef.current = gis2d;

  useEffect(() => {
    if (!viewer || !ready || !parcels || viewer.isDestroyed()) return;
    if (parcels.features.length === 0) return;

    const grid = createBucketGrid(
      viewer,
      'survey-parcels',
      extentOf(parcels.features.map((f) => {
        const ring = (f.geometry.coordinates as number[][][])[0];
        return [ring[0][0], ring[0][1]] as const;
      })),
    );

    // ONE shared condition object across every label, not one per entity: a
    // constant property keeps Cesium's static geometry path, and 326 identical
    // allocations would achieve nothing. The idiom every other layer here uses.
    const labelCondition = new Cesium.DistanceDisplayCondition(
      0, SURVEY_PARCEL_VIEW.LABEL_MAX_DISTANCE_M,
    );
    const labelScale = new Cesium.NearFarScalar(
      SURVEY_PARCEL_VIEW.LABEL_SCALE_NEAR_M, 1.0,
      SURVEY_PARCEL_VIEW.LABEL_SCALE_FAR_M, SURVEY_PARCEL_VIEW.LABEL_SCALE_FAR,
    );

    const addParcel = (feature: (typeof parcels.features)[number]) => {
      const props = feature.properties as SurveyParcelProps;
      const ring = (feature.geometry.coordinates as number[][][])[0];
      const flat = flatLonLat(ring);
      if (flat.length < 6) return;

      const pid = props.id;
      const ds = grid.forPoint(ring[0][0], ring[0][1]);
      ds.show = showRef.current;

      // The pickable surface. Constant material: see the header for why the
      // callbacks are on the boundary instead.
      const face = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(flat),
          ),
          material: new Cesium.ColorMaterialProperty(MATERIALS.surveyParcelFill),
          outline: false,
          // BOTH rather than TERRAIN, for the same reason ParcelsLayer gives:
          // in Photoreal mode the globe surface is hidden and the ground the
          // user sees is the tileset's mesh.
          classificationType: Cesium.ClassificationType.BOTH,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(face, { kind: 'surveyParcel', id: pid });

      // The boundary, and the only thing that changes per frame.
      ds.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
          width: new Cesium.CallbackProperty(() => {
            const s = stateRef.current;
            return s.activeId === pid || s.hoveredId === pid
              ? SURVEY_PARCEL_VIEW.OUTLINE_ACTIVE_PX
              : SURVEY_PARCEL_VIEW.OUTLINE_PX;
          }, false),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const s = stateRef.current;
              const base = s.activeId === pid
                ? MATERIALS.surveyParcelActive
                : s.hoveredId === pid
                  ? MATERIALS.surveyParcelHover
                  : MATERIALS.surveyParcelOutline;
              return base.withAlpha(base.alpha * s.fade);
            }, false),
          ),
        },
      });

      // The parcel number. Positioned at the pole of inaccessibility rather
      // than the centroid: a plot clipped around a junction is often an L, and
      // the average of its vertices lands on the neighbour's land.
      const at = ringPoleOfInaccessibility(ring);
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat),
        label: {
          text: props.label,
          font: SURVEY_PARCEL_VIEW.LABEL_FONT,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: MATERIALS.surveyParcelLabelFill,
          outlineColor: MATERIALS.surveyParcelLabelOutline,
          outlineWidth: SURVEY_PARCEL_VIEW.LABEL_OUTLINE_PX,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Clamped to the ground so a label sits on the terrain under it
          // rather than at ellipsoid height, which over Siripuram's 63 m of
          // relief would leave numbers floating above the far side of the ward.
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: labelCondition,
          scaleByDistance: labelScale,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    };

    const cancelBuild = buildIncrementally({
      items: parcels.features,
      step: addParcel,
      firstSlice: 200,
      onSlice: () => {
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
    });

    return () => {
      cancelBuild();
      grid.dispose();
    };
  }, [viewer, ready, parcels]);

  /** Push store values into the ref the callbacks read. No rebuild. */
  useEffect(() => {
    const s = stateRef.current;
    s.activeId = activeId;
    s.hoveredId = hoveredId;
    s.fadeTarget = gis2d ? 1 : 0;
    if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender();
  }, [activeId, hoveredId, gis2d, viewer]);

  /**
   * One rAF loop for the whole layer, which parks itself once settled.
   *
   * The viewer runs in requestRenderMode, so a loop that kept scheduling would
   * also keep asking for frames -- the fade has to stop, not merely finish.
   */
  useEffect(() => {
    if (!viewer) return undefined;
    let raf = 0;
    const step = () => {
      const s = stateRef.current;
      const delta = s.fadeTarget - s.fade;
      if (Math.abs(delta) <= 0.002) {
        s.fade = s.fadeTarget;
        raf = 0;
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
        return;
      }
      s.fade += delta * FADE_RATE;
      if (!viewer.isDestroyed()) viewer.scene.requestRender();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [gis2d, viewer]);

  /** Show or hide the whole grid. A flip, never a rebuild. */
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      // startsWith: the grid is named survey-parcels#0 .. survey-parcels#15.
      if (ds.name.startsWith('survey-parcels')) ds.show = gis2d;
    }
    viewer.scene.requestRender();
  }, [viewer, gis2d, parcels]);

  return null;
}
