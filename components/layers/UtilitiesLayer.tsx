'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import {
  MATERIALS, UTILITY_SELECTED, UTILITY_TUBE_COLOR, tubeShape,
} from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import { createBucketGrid, extentOf, type BucketGrid } from '@/lib/cesium/spatial-buckets';
import { flatLonLat } from '@/lib/geo';
import {
  UNDERGROUND_ORDER, categoryOfAssetType, type UtilityCategory,
} from '@/lib/underground/categories';
import type { GroundField } from '@/lib/underground/ground-field';
import {
  fallbackDatum, fieldBboxFor, useGroundField,
} from '@/lib/underground/use-ground-field';
import {
  layoutRun, resolveCategoryDepths, type DisplayRun,
} from '@/lib/underground/layout';
import type { GeoFeature, UtilityProps } from '@/lib/types';

/**
 * The underground networks, one layer per category.
 *
 * WHAT CHANGED AND WHY. This drew every buried run into ONE data source,
 * behind ONE boolean, at the Z the database happened to store. Three
 * consequences, all of them the "underground is unreadable" symptom:
 *
 *   - The stored Z is `avg(ground_elev) + depth_m` for the whole AOI
 *     (scripts/utilities.sql:36-39). Over Siripuram's 63 m of relief that put
 *     48 % of the "1 m deep" power network ABOVE the ground under it, up to
 *     +40 m in the air and through buildings -- and every run of a class on
 *     one plane, so they intersected each other at every junction.
 *   - There was no way to look at one network. Water, sewer, power and metro
 *     arrived together or not at all.
 *   - Everything was built at boot whether or not anyone opened the mode.
 *
 * All three are addressed by the same restructuring. Geometry comes from
 * lib/underground/layout.ts, which re-hangs each run off the terrain under it
 * and gives each category its own corridor; each category gets its own bucket
 * grid, so toggling one is a `show` flip and hiding one costs nothing; and a
 * category is not MOUNTED until the user first asks for it, so a scene nobody
 * takes underground builds no buried geometry at all.
 *
 * WHAT DID NOT CHANGE, deliberately. Selection is still a single highlight
 * entity created on demand rather than a per-run CallbackProperty asking every
 * frame whether it is the chosen one -- 1,514 of them answering no, forever,
 * was the cost that idiom was introduced to remove. Runs still carry a
 * distance condition; a 0.25 m pipe is sub-pixel from the city view and
 * PolylineVolume is the most expensive geometry per metre in the app.
 */

/** Camera distance beyond which buried runs stop being drawn, metres. */
const VISIBLE_WITHIN_M = 3000;

/**
 * Basement storey height, metres.
 *
 * Mirrors scripts/build_geometry.sql:295, which generates the floor prisms at
 * `ground_elev + lvl * 3.2`. The foundations layer has to agree with the slabs
 * the floor view draws or a basement would have two different depths.
 */
const BASEMENT_FLOOR_H = 3.2;

export default function UtilitiesLayer() {
  const { viewer, ground, ready, project } = useViewer();
  const utilities = useDataStore((s) => s.utilities);
  const buildings = useDataStore((s) => s.buildings);
  const showUtilities = useViewStore((s) => s.layers.utilities);
  const strata = useViewStore((s) => s.undergroundLayers);

  /**
   * Categories that have ever been asked for.
   *
   * Mounting is what builds, so this set is the lazy-loading gate. It only
   * grows: a category the user switches off keeps its geometry and is hidden,
   * because rebuilding a 400-run network every time someone re-ticks a box is
   * the cost this structure exists to avoid.
   */
  const [mounted, setMounted] = useState<UtilityCategory[]>([]);
  useEffect(() => {
    if (!showUtilities) return;
    const missing = UNDERGROUND_ORDER.filter((k) => strata[k] && !mounted.includes(k));
    if (missing.length > 0) setMounted((prev) => [...prev, ...missing]);
  }, [showUtilities, strata, mounted]);

  /**
   * The terrain surface, as a function of position.
   *
   * Sampled lazily, on the first request for any category, for the same reason
   * the categories are mounted lazily: a session that never goes underground
   * should not pay for it. Shared with ConflictLayer through the hook's cache,
   * so the pulsing overlay lands exactly on the pipe it is flagging -- which
   * is also why both compute the domain the same way.
   */
  const fieldBbox = useMemo(
    () => fieldBboxFor(project?.bbox, utilities?.features, buildings?.features),
    [project, utilities, buildings],
  );
  const wanted = showUtilities && mounted.length > 0;
  const field = useGroundField(
    viewer, ready, fieldBbox, fallbackDatum(ground), wanted,
  );

  /** Per-category depth offsets. One pass over the runs, not one per run. */
  const adjust = useMemo(
    () => resolveCategoryDepths(utilities?.features ?? []),
    [utilities],
  );

  /**
   * Ground reference for a run that belongs to a building.
   *
   * A riser up a tower was authored against that building's own ground_elev,
   * not against the AOI mean, and has to be reconciled against the terrain
   * sampled under it -- the same reconciliation toSceneZ() performs for the
   * building's storeys. Without this a riser detaches from the tower it climbs.
   */
  const buildingGround = useMemo(() => {
    const stored = new Map<number, number>();
    for (const f of buildings?.features ?? []) {
      stored.set(f.properties.id, f.properties.ground_elev);
    }
    return (id: number) => {
      const s = stored.get(id);
      const t = ground.get(id);
      return s === undefined || t === undefined ? null : { stored: s, terrain: t };
    };
  }, [buildings, ground]);

  if (!viewer || !ready || !field) return null;

  return (
    <>
      {mounted.map((category) => (
        <CategoryRuns
          key={category}
          category={category}
          field={field}
          adjust={adjust}
          buildingGround={buildingGround}
        />
      ))}
      <SelectionHighlight
        field={field}
        adjust={adjust}
        buildingGround={buildingGround}
      />
    </>
  );
}

interface LayoutProps {
  field: GroundField;
  adjust: Partial<Record<UtilityCategory, number>>;
  buildingGround: (id: number) => { stored: number; terrain: number } | null;
}

/**
 * One category's runs, in their own bucket grid.
 *
 * Its own grid rather than a shared one so that hiding a category is a `show`
 * flip over its own data sources and touches nothing else -- and so that the
 * frustum can still reject the far half of a network when the camera is down
 * among the pipes, which is where this mode is used.
 */
function CategoryRuns({
  category,
  field,
  adjust,
  buildingGround,
}: { category: UtilityCategory } & LayoutProps) {
  const { viewer, ready } = useViewer();
  const utilities = useDataStore((s) => s.utilities);
  const showUtilities = useViewStore((s) => s.layers.utilities);
  const on = useViewStore((s) => s.undergroundLayers[category]);
  const visible = showUtilities && on;

  const gridRef = useRef<BucketGrid | null>(null);
  /**
   * Read inside the build so that a bucket created AFTER a toggle is born with
   * the current visibility. The effect below only reaches buckets that already
   * exist, and a slow build can outlive several clicks.
   */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const runs = useMemo(() => {
    const out: DisplayRun[] = [];
    for (const f of utilities?.features ?? []) {
      const props = f.properties as UtilityProps;
      if (categoryOfAssetType(props.asset_type) !== category) continue;
      const line = (f as GeoFeature<UtilityProps>).geometry.coordinates as number[][];
      if (!Array.isArray(line) || line.length < 2) continue;
      const planned = layoutRun({ props, coordinates: line }, { field, adjust, buildingGround });
      if (planned) out.push(planned);
    }
    return out;
  }, [utilities, category, field, adjust, buildingGround]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed() || runs.length === 0) return;

    const extent = extentOf(
      runs.flatMap((r) => {
        const pts: [number, number][] = [];
        for (let i = 0; i < r.tube.length; i += 3) pts.push([r.tube[i], r.tube[i + 1]]);
        for (const s of r.risers) pts.push([s.lon, s.lat]);
        return pts;
      }),
    );
    const grid = createBucketGrid(viewer, `utilities:${category}`, extent);
    gridRef.current = grid;

    const visibility = new Cesium.DistanceDisplayCondition(0, VISIBLE_WITHIN_M);
    // One material for the whole category rather than one per run: 400 runs
    // that share a colour should share the object that says so.
    const material = new Cesium.ColorMaterialProperty(
      UTILITY_TUBE_COLOR[category],
    );

    const addRun = (run: DisplayRun) => {
      const radius = run.radiusM;

      if (run.tube.length >= 6) {
        const ds = grid.forPoint(run.tube[0], run.tube[1]);
        ds.show = visibleRef.current;
        const entity = ds.entities.add({
          polylineVolume: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(run.tube),
            shape: tubeShape(radius),
            cornerType: Cesium.CornerType.ROUNDED,
            material,
            shadows: Cesium.ShadowMode.DISABLED,
            distanceDisplayCondition: visibility,
          },
        });
        tagEntity(entity, { kind: 'utility', id: run.id });
      }

      // Vertical sections: a riser up a building, a drop into a trench. A
      // swept volume cannot express these (see planRunGeometry), so each is a
      // cylinder of the same radius, tagged with the same id -- clicking a
      // riser selects the run it belongs to, exactly as clicking its tube does.
      for (const r of run.risers) {
        const ds = grid.forPoint(r.lon, r.lat);
        ds.show = visibleRef.current;
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
        tagEntity(entity, { kind: 'utility', id: run.id });
      }
    };

    // PolylineVolume is the heaviest geometry here: a swept tube with rounded
    // corners per run. Slicing keeps a whole network off the critical path of
    // the click that asked for it.
    const cancelBuild = buildIncrementally({
      items: runs,
      step: addRun,
      firstSlice: 120,
      onSlice: () => {
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
    });

    return () => {
      cancelBuild();
      grid.dispose();
      gridRef.current = null;
    };
  }, [viewer, ready, runs, category]);

  // Visibility is a cheap show/hide, never a rebuild.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !viewer || viewer.isDestroyed()) return;
    for (const ds of grid.all()) ds.show = visible;
    viewer.scene.requestRender();
  }, [viewer, visible, runs]);

  return category === 'foundations'
    ? <FoundationVolumes visible={visible} />
    : null;
}

/**
 * Basement envelopes, as the Foundations category.
 *
 * DERIVED FROM THE CADASTRE, not supplied as utility data: a building's
 * `basements` count and its footprint are real attributes the viewer already
 * holds, and the depth is the same 3.2 m storey pitch the floor prisms use.
 * That is why this category needs no dataset of its own and states nothing the
 * register does not already say -- inventing a foundation network would have
 * been the easy way to fill the checkbox and the wrong one.
 *
 * Tagged as its BUILDING rather than as a utility, so clicking a foundation
 * opens the property it belongs to. A basement is not a service.
 */
function FoundationVolumes({ visible }: { visible: boolean }) {
  const { viewer, ground, ready } = useViewer();
  const buildings = useDataStore((s) => s.buildings);
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!viewer || !ready || !buildings || viewer.isDestroyed()) return;

    const ds = new Cesium.CustomDataSource('utilities:foundations:volumes');
    ds.show = visibleRef.current;
    viewer.dataSources.add(ds);
    dsRef.current = ds;

    const withBasements = buildings.features.filter((f) => f.properties.basements >= 1);
    const material = new Cesium.ColorMaterialProperty(MATERIALS.basementSlab.withAlpha(0.45));
    const visibility = new Cesium.DistanceDisplayCondition(0, VISIBLE_WITHIN_M);

    const cancelBuild = buildIncrementally({
      items: withBasements,
      step: (f) => {
        const props = f.properties;
        const ring = (f.geometry.coordinates as number[][][])[0];
        if (!Array.isArray(ring) || ring.length < 4) return;
        // Terrain where it was sampled, the stored elevation where it was not.
        const base = ground.get(props.id) ?? props.ground_elev;
        const depth = props.basements * BASEMENT_FLOOR_H;
        const entity = ds.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(flatLonLat(ring)),
            ),
            height: base - depth,
            extrudedHeight: base,
            material,
            outline: false,
            shadows: Cesium.ShadowMode.DISABLED,
            distanceDisplayCondition: visibility,
          },
        });
        tagEntity(entity, { kind: 'building', id: props.id });
      },
      firstSlice: 60,
      onSlice: () => {
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
    });

    return () => {
      cancelBuild();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer, ready, buildings, ground]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !dsRef.current) return;
    dsRef.current.show = visible;
    viewer.scene.requestRender();
  }, [viewer, visible, buildings]);

  return null;
}

/**
 * The selected run, redrawn once as its own entity in the selection colour.
 *
 * Sits exactly on the base tube rather than replacing it: at the same
 * positions and a hair more radius the two are coincident, so the selection
 * colour is simply what you see. One entity, created on demand and removed on
 * deselect -- which is what keeps every other run in the scene a constant
 * colour with nothing to evaluate per frame.
 */
function SelectionHighlight({ field, adjust, buildingGround }: LayoutProps) {
  const { viewer, ready } = useViewer();
  const utilities = useDataStore((s) => s.utilities);
  const selectedUtilityId = useViewStore((s) => s.selectedUtilityId);
  const showUtilities = useViewStore((s) => s.layers.utilities);
  const strata = useViewStore((s) => s.undergroundLayers);

  useEffect(() => {
    if (!viewer || !ready || !utilities || viewer.isDestroyed()) return;
    if (selectedUtilityId === null || !showUtilities) return;

    const feature = utilities.features.find(
      (f) => (f.properties as UtilityProps).id === selectedUtilityId,
    );
    if (!feature) return;
    const props = feature.properties as UtilityProps;
    const line = feature.geometry.coordinates as number[][];
    if (!Array.isArray(line) || line.length < 2) return;

    const run = layoutRun({ props, coordinates: line }, { field, adjust, buildingGround });
    // A selection in a hidden stratum draws nothing: a lit pipe floating in an
    // empty scene reads as a bug rather than as a selection.
    if (!run || !strata[run.category]) return;

    const ds = new Cesium.CustomDataSource('utility-selection');
    viewer.dataSources.add(ds);
    // A hair fatter than the base geometry so it cannot z-fight with it.
    const radius = run.radiusM * 1.06;
    const material = new Cesium.ColorMaterialProperty(UTILITY_SELECTED);

    if (run.tube.length >= 6) {
      const entity = ds.entities.add({
        polylineVolume: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(run.tube),
          shape: tubeShape(radius),
          cornerType: Cesium.CornerType.ROUNDED,
          material,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      // Tagged like the base run, so clicking the highlight keeps the selection
      // rather than reading as a click on bare ground.
      tagEntity(entity, { kind: 'utility', id: props.id });
    }
    for (const r of run.risers) {
      const entity = ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, (r.z0 + r.z1) / 2),
        cylinder: {
          length: r.z1 - r.z0,
          topRadius: radius,
          bottomRadius: radius,
          material,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(entity, { kind: 'utility', id: props.id });
    }
    viewer.scene.requestRender();

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [
    viewer, ready, utilities, selectedUtilityId, showUtilities, strata,
    field, adjust, buildingGround,
  ]);

  return null;
}
