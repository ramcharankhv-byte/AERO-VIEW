'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo, useRef } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useEnsureSite, useSiteIndex, useViewStore } from '@/lib/store';
import {
  INFRA_COLOR, INFRA_DEFAULT, INFRA_SELECTED, INFRA_SELECTED_OUTLINE,
} from '@/lib/cesium/materials';
import { tagEntity } from '@/lib/cesium/tag';
import { buildIncrementally } from '@/lib/cesium/build-queue';
import { createBucketGrid, extentOf, type BucketGrid } from '@/lib/cesium/spatial-buckets';
import { placeSite, structuralDatum } from '@/lib/infra/build';
import type { ComponentLod, PlacedComponent, PlacedSite } from '@/lib/infra/types';
import {
  fallbackDatum, fieldBboxFor, unionBbox, useGroundField,
} from '@/lib/underground/use-ground-field';

/**
 * The active infrastructure site: a railway station, a flyover.
 *
 * LAZY BY CONSTRUCTION. Nothing here runs until a site is opened. The
 * specification is fetched then (useEnsureSite), the geometry is built then,
 * and closing the site tears both down. A project with several sites therefore
 * costs one, and a session that never opens one costs nothing at all -- which
 * is the whole reason a site is a separate fetch from the index that lists it.
 *
 * GEOMETRY COMES FROM A SPEC, NOT A MESH. lib/infra/build.ts turns "a 12 m
 * platform, 550 m long, repeated eight times at 26 m centres" into rings and
 * columns; this file turns those into primitives and decides nothing about
 * where they go. That separation is what makes the structures reviewable as
 * text and testable without a WebGL context.
 *
 * WHY ENTITIES RATHER THAN HAND-BATCHED GeometryInstances. Cesium already
 * merges the static geometry inside one data source into as few primitives as
 * it can -- it is how BuildingsLayer draws 2,597 extruded footprints in
 * roughly one draw call. A site is 76 components. Building the batch by hand
 * would cost the per-component distance conditions and the per-entity picking
 * this layer depends on, and buy nothing measurable. The bucket grid below is
 * the part that does pay: it splits the batch so the frustum can reject the
 * far end of a 700 m station while the camera is standing on platform 1.
 */

/**
 * Distance bands per detail level, metres.
 *
 * `far` is the massing that makes the place recognisable from the air. `mid`
 * is the parts you read once you are over it. `near` is detail that is
 * sub-pixel until you are among it -- pier caps, barriers -- and is pure cost
 * before then.
 */
const LOD_RANGE: Record<ComponentLod, number> = {
  far: 9000,
  // Sized against the SITE framing, not against a round number: the camera
  // stands off a 1.4 km structure by rather more than a kilometre, and a band
  // that stopped short of that culled every pillar in the default view.
  mid: 2200,
  near: 600,
};

export default function InfraSiteLayer() {
  const { viewer, ground, ready, project } = useViewer();
  const activeSiteId = useViewStore((s) => s.activeSiteId);
  const selectedComponent = useViewStore((s) => s.selectedComponent);
  const gis2d = useViewStore((s) => s.gis2d);
  const utilities = useDataStore((s) => s.utilities);
  const buildings = useDataStore((s) => s.buildings);

  const spec = useEnsureSite(activeSiteId);
  // Already loaded by the navigator; this is a read, not a second fetch.
  const sites = useSiteIndex();

  /**
   * Ground under the site, from the field the underground layers already
   * sample. The SAME domain they use, so all three share one terrain batch
   * rather than taking three.
   */
  const fieldBbox = useMemo(() => {
    const cadastre = fieldBboxFor(project?.bbox, utilities?.features, buildings?.features);
    const entry = sites.find((x) => x.id === activeSiteId);
    return entry ? unionBbox(cadastre, entry.extent) : cadastre;
  }, [project, utilities, buildings, sites, activeSiteId]);
  const field = useGroundField(
    viewer, ready, fieldBbox, fallbackDatum(ground), spec !== null,
  );

  /**
   * The level the structure is graded to.
   *
   * The HIGHEST ground under the structural footprints, not an average and not
   * the height under the anchor. Anything lower puts a top face under the
   * terrain somewhere on a site with 13.7 m of relief across it, and Cesium
   * depth-tests against terrain, so the buried part simply vanishes -- which
   * is what an average datum did to most of the platforms.
   *
   * Nothing is left hovering as a result: lib/infra/build.ts drops the
   * underside of every at-grade structure to meet the ground beneath it, so
   * the space a level surface leaves over falling ground is filled by the
   * retaining wall a real platform would stand on.
   */
  const siteGround = useMemo(() => {
    if (!spec || !field) return null;
    const heightAt = (lon: number, lat: number) => field.heightAt(lon, lat);
    return { datum: structuralDatum(spec, heightAt), heightAt };
  }, [spec, field]);

  /**
   * The placed structure, or null.
   *
   * NULL IN THE 2D GIS VIEW, which drops the whole layer to nothing rather
   * than hiding it: a station's platforms and a flyover's pillars are
   * modelled solids, and there is no sensible way to draw one on a top-down
   * cadastral sheet. This is a memo rather than a `show` flag because the
   * cost of rebuilding the site is a few hundred entities on the rare
   * occasion someone has a site open AND opens the 2D view, whereas hiding
   * it would leave several hundred entities in the scene graph for a mode
   * that has nothing to do with them. See components/globe/Scene.tsx for the
   * rule this follows.
   */
  const site: PlacedSite | null = useMemo(
    () => (spec && siteGround && !gis2d ? placeSite(spec, siteGround) : null),
    [spec, siteGround, gis2d],
  );

  /**
   * Pick handle -> component, for the Picker and the panel.
   *
   * Published on the data store rather than passed down, because the two
   * consumers are a global event handler and a panel mounted outside this
   * tree. Kept as a ref on the module's own map rather than in the store: it
   * is derived from `site` and rebuilding it is free, so putting it in state
   * would only add a render.
   */
  const byPickId = useMemo(() => {
    const m = new Map<number, PlacedComponent>();
    for (const c of site?.components ?? []) m.set(c.pickId, c);
    return m;
  }, [site]);
  useEffect(() => {
    componentIndex = byPickId;
    return () => { componentIndex = new Map(); };
  }, [byPickId]);

  // ---- build ---------------------------------------------------------------
  useEffect(() => {
    if (!viewer || !ready || !site || viewer.isDestroyed()) return;

    // Late-slice teardown: flipped false in the cleanup so a slice still
    // in flight when the site changes (or the viewer is destroyed) skips
    // the entity add rather than writing into a disposed bucket. The
    // other near-tier layers (BuildingsLayer, BuildingsFarLayer) hold
    // the same flag and check it at the top of their step. Without
    // this, a 48-component first slice crossing a site change leaves
    // 0..48 dangling entities for the bucket's dispose to clean up,
    // and the entity-id space can collide with the next site's tags.
    const aliveRef = { current: true };

    const points: [number, number][] = [];
    for (const c of site.components) {
      if (c.kind === 'road') continue;
      for (const ring of c.rings) {
        for (let i = 0; i < ring.length; i += 2) points.push([ring[i], ring[i + 1]]);
      }
      for (const col of c.columns) points.push([col.lon, col.lat]);
    }
    const grid: BucketGrid = createBucketGrid(viewer, `infra:${site.id}`, extentOf(points));

    // One material and one distance condition per (kind, lod), not per
    // component: sixteen pillars share a tone and a band, and sixteen copies of
    // the objects that say so is sixteen chances for them to drift apart.
    const materials = new Map<string, Cesium.ColorMaterialProperty>();
    const conditions = new Map<ComponentLod, Cesium.DistanceDisplayCondition>();
    const materialFor = (kind: string) => {
      let m = materials.get(kind);
      if (!m) {
        m = new Cesium.ColorMaterialProperty(INFRA_COLOR[kind] ?? INFRA_DEFAULT);
        materials.set(kind, m);
      }
      return m;
    };
    const conditionFor = (lod: ComponentLod) => {
      let c = conditions.get(lod);
      if (!c) {
        c = new Cesium.DistanceDisplayCondition(0, LOD_RANGE[lod]);
        conditions.set(lod, c);
      }
      return c;
    };
    const shadows = new Cesium.ConstantProperty(Cesium.ShadowMode.DISABLED);

    /**
     * Streets are NOT drawn here.
     *
     * They are in the spec because scripts/build_vizag_infra.mjs derives
     * data/api/vizag-infra/roads.json from them -- that is their job. Drawing
     * them again as slabs would put two representations of one street in the
     * scene: RoadsLayer already clamps the same centrelines to the ground,
     * where a street belongs in this application, and the two were visibly
     * fighting each other over the junction.
     */
    const addComponent = (c: PlacedComponent) => {
      if (!aliveRef.current) return;
      if (c.kind === 'road') return;
      const material = materialFor(c.kind);
      const distanceDisplayCondition = conditionFor(c.lod);

      c.rings.forEach((flat, i) => {
        const ds = grid.forPoint(flat[0], flat[1]);
        const entity = ds.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(flat),
            ),
            height: c.base[i],
            extrudedHeight: c.top[i],
            material,
            shadows,
            distanceDisplayCondition,
          },
        });
        tagEntity(entity, { kind: 'infra', id: c.pickId, ref: c.ref });
      });

      for (const col of c.columns) {
        const ds = grid.forPoint(col.lon, col.lat);
        const entity = ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(
            col.lon, col.lat, col.base + col.height / 2,
          ),
          cylinder: {
            length: col.height,
            topRadius: col.radius,
            bottomRadius: col.radius,
            material,
            shadows,
            distanceDisplayCondition,
          },
        });
        tagEntity(entity, { kind: 'infra', id: c.pickId, ref: c.ref });
      }
    };

    const cancelBuild = buildIncrementally({
      items: site.components,
      step: addComponent,
      // A station is 76 components and the first slice is what the user sees
      // after clicking its name, so most of it lands in the first frame.
      firstSlice: 48,
      onSlice: () => {
        if (!viewer.isDestroyed()) viewer.scene.requestRender();
      },
    });

    return () => {
      aliveRef.current = false;
      cancelBuild();
      grid.dispose();
    };
  }, [viewer, ready, site]);

  // ---- selection highlight -------------------------------------------------
  //
  // One entity set, created on demand and removed on deselect -- the idiom
  // RoadsLayer established and UtilitiesLayer follows. The alternative, a
  // CallbackProperty on every component asking each frame whether it is the
  // chosen one, costs a per-frame evaluation on hundreds of parts to answer no
  // for all but one of them.
  useEffect(() => {
    if (!viewer || !ready || !site || viewer.isDestroyed()) return;
    if (!selectedComponent || selectedComponent.siteId !== site.id) return;
    const c = site.components.find((x) => x.ref === selectedComponent.ref);
    if (!c) return;

    const ds = new Cesium.CustomDataSource('infra-selection');
    viewer.dataSources.add(ds);
    const material = new Cesium.ColorMaterialProperty(INFRA_SELECTED);

    c.rings.forEach((flat, i) => {
      // A hair proud of the component itself, so the highlight cannot z-fight
      // with the surface it is highlighting.
      const entity = ds.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(flat),
          ),
          height: c.base[i] - 0.05,
          extrudedHeight: c.top[i] + 0.05,
          material,
          outline: true,
          outlineColor: INFRA_SELECTED_OUTLINE,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(entity, { kind: 'infra', id: c.pickId, ref: c.ref });
    });
    for (const col of c.columns) {
      const entity = ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(
          col.lon, col.lat, col.base + col.height / 2,
        ),
        cylinder: {
          length: col.height + 0.1,
          topRadius: col.radius * 1.06,
          bottomRadius: col.radius * 1.06,
          material,
          shadows: Cesium.ShadowMode.DISABLED,
        },
      });
      tagEntity(entity, { kind: 'infra', id: c.pickId, ref: c.ref });
    }
    viewer.scene.requestRender();

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer, ready, site, selectedComponent]);

  return null;
}

/**
 * Pick handle -> component, for the one consumer that cannot reach React state:
 * the DetailPanel, which mounts outside the Cesium tree.
 *
 * A module-level map rather than store state on purpose. It is DERIVED from the
 * active site and is rebuilt whenever that changes, so putting it in the store
 * would add a render and a second source of truth for something that already
 * has one. It is cleared when the layer unmounts.
 */
let componentIndex = new Map<number, PlacedComponent>();

/** The placed component behind a pick handle, or null. */
export function componentForPickId(pickId: number): PlacedComponent | null {
  return componentIndex.get(pickId) ?? null;
}

/** The placed component with this ref on the active site, or null. */
export function componentForRef(ref: string): PlacedComponent | null {
  for (const c of componentIndex.values()) if (c.ref === ref) return c;
  return null;
}
