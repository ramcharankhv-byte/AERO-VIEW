'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { CONFLICT_COLOR, CONFLICT_COLOR_DIM, tubeShape } from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { categoryOfAssetType } from '@/lib/underground/categories';
import {
  fallbackDatum, fieldBboxFor, useGroundField,
} from '@/lib/underground/use-ground-field';
import { layoutRun, resolveCategoryDepths } from '@/lib/underground/layout';
import type { UtilityProps } from '@/lib/types';

/**
 * Pulsing overlay on utility runs that ST_3DIntersects flagged as passing
 * through a basement.
 *
 * Drawn as a slightly fatter tube sitting over the UtilitiesLayer geometry, so
 * the underlying asset colour stays readable while the conflict is unmissable.
 *
 * IT MUST PLAN ITS GEOMETRY THE WAY THE BASE LAYER DOES. The overlay only
 * means anything while it is coincident with the run it is flagging, and the
 * base layer no longer draws runs at their stored Z -- it re-hangs them off
 * the terrain and gives each category its own corridor. Sharing layoutRun,
 * the same `adjust`, and the same cached ground field is what keeps the two
 * together; computing either independently would leave a red tube hovering
 * beside the pipe it accuses.
 *
 * It also honours the per-category switches. A conflict on a stratum the user
 * has hidden would otherwise be a pulsing tube with nothing inside it.
 */

/**
 * Camera distance beyond which the overlay stops being drawn, metres.
 *
 * Deliberately the same figure UtilitiesLayer uses. This layer had no
 * distance condition at all, which made these tubes the only utility geometry
 * drawn at city scale: a handful of unlabelled sub-pixel red pulses over the
 * whole AOI, with the network they belong to already culled.
 */
const VISIBLE_WITHIN_M = 3000;

export default function ConflictLayer() {
  const { viewer, ground, ready, project } = useViewer();
  const utilities = useDataStore((s) => s.utilities);
  const buildings = useDataStore((s) => s.buildings);
  const conflicts = useDataStore((s) => s.conflicts);
  const underground = useViewStore((s) => s.underground);
  const gis2d = useViewStore((s) => s.gis2d);
  const showUtilities = useViewStore((s) => s.layers.utilities);
  const strata = useViewStore((s) => s.undergroundLayers);

  const conflictedIds = useMemo(
    () => new Set(conflicts.map((c) => c.utility_id)),
    [conflicts],
  );

  // Computed exactly as UtilitiesLayer computes it, so the two resolve to the
  // same cache key and share one sampled field. A different domain here would
  // mean a second terrain batch AND an overlay a metre off its pipe.
  const fieldBbox = useMemo(
    () => fieldBboxFor(project?.bbox, utilities?.features, buildings?.features),
    [project, utilities, buildings],
  );
  const field = useGroundField(
    viewer,
    ready,
    fieldBbox,
    fallbackDatum(ground),
    underground && showUtilities && conflictedIds.size > 0,
  );

  const adjust = useMemo(
    () => resolveCategoryDepths(utilities?.features ?? []),
    [utilities],
  );

  /** Same building reconciliation the base layer applies. See UtilitiesLayer. */
  const buildingGround = useMemo(() => {
    const stored = new Map<number, number>();
    for (const f of buildings?.features ?? []) {
      stored.set(f.properties.id, f.properties.ground_elev);
    }
    return (id: number) => {
      const st = stored.get(id);
      const t = ground.get(id);
      return st === undefined || t === undefined ? null : { stored: st, terrain: t };
    };
  }, [buildings, ground]);

  useEffect(() => {
    if (!viewer || !ready || !utilities || !field || viewer.isDestroyed()) return;
    if (conflictedIds.size === 0) return;

    const ds = new Cesium.CustomDataSource('conflicts');
    viewer.dataSources.add(ds);

    const visibility = new Cesium.DistanceDisplayCondition(0, VISIBLE_WITHIN_M);

    // One clock-driven pulse shared by every flagged segment.
    //
    // Two details matter at frame rate. The lerp writes into a SCRATCH colour
    // rather than allocating -- this runs once per flagged entity per frame,
    // and `new Cesium.Color()` inside it made the pulse a steady source of
    // garbage. And the phase is computed once per frame, not once per entity:
    // every segment must pulse in step anyway, so re-deriving it per entity was
    // both wasted work and a way for two segments either side of a millisecond
    // boundary to disagree.
    const scratch = new Cesium.Color();
    let phaseFrame = -1;
    let phase = 0;
    const pulse = () => {
      const now = Date.now();
      if (now !== phaseFrame) {
        phaseFrame = now;
        const t = (now % 1400) / 1400;
        phase = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
      }
      return Cesium.Color.lerp(CONFLICT_COLOR_DIM, CONFLICT_COLOR, phase, scratch);
    };

    for (const feature of utilities.features) {
      const props = feature.properties as UtilityProps;
      if (!conflictedIds.has(props.id)) continue;
      const line = feature.geometry.coordinates as number[][];
      if (!Array.isArray(line) || line.length < 2) continue;

      // Planned by the base layer's own function, so the overlay lands on the
      // run rather than beside it. That also handles the vertical-run split: a
      // conflicted riser would otherwise throw on normalise and take the whole
      // batch with it. See planRunGeometry.
      const run = layoutRun(
        { props, coordinates: line },
        { field, adjust, buildingGround },
      );
      if (!run) continue;
      const { tube, risers } = run;
      const radius = run.radiusM * 1.55;
      const material = new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(pulse, false),
      );

      if (tube.length >= 6) {
        const entity = ds.entities.add({
          polylineVolume: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(tube),
            shape: tubeShape(radius),
            cornerType: Cesium.CornerType.ROUNDED,
            material,
            shadows: Cesium.ShadowMode.DISABLED,
            distanceDisplayCondition: visibility,
          },
        });
        tagEntity(entity, { kind: 'utility', id: props.id });
      }
      for (const r of risers) {
        const entity = ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, (r.z0 + r.z1) / 2),
          cylinder: {
            length: r.z1 - r.z0,
            topRadius: radius,
            bottomRadius: radius,
            material,
            shadows: Cesium.ShadowMode.DISABLED,
            distanceDisplayCondition: visibility,
          },
        });
        tagEntity(entity, { kind: 'utility', id: props.id });
      }
    }

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, utilities, conflictedIds, field, adjust, buildingGround]);

  /**
   * Visibility, per entity as well as per source.
   *
   * Conflicts land on more than one category, so hiding the whole overlay
   * because one of them is switched off would lose the rest.
   */
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const typeById = new Map<number, string>();
    for (const f of utilities?.features ?? []) {
      const p = f.properties as UtilityProps;
      typeById.set(p.id, p.asset_type);
    }
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const ds = viewer.dataSources.get(i);
      if (ds.name !== 'conflicts') continue;
      ds.show = underground && showUtilities && !gis2d;
      for (const e of ds.entities.values) {
        const id = (e as { tag?: { id: number } }).tag?.id;
        const type = id === undefined ? undefined : typeById.get(id);
        const cat = type ? categoryOfAssetType(type) : null;
        e.show = cat ? strata[cat] : true;
      }
    }
    viewer.scene.requestRender();
  }, [viewer, underground, showUtilities, gis2d, strata, utilities, conflicts]);

  return null;
}
