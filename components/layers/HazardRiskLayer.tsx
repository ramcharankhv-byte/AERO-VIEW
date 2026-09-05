'use client';

import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { useEffect, useMemo } from 'react';
import { useViewer } from '../globe/CesiumRoot';
import { useDataStore, useViewStore } from '@/lib/store';
import { RISK_COLOR } from '@/lib/cesium/materials';
import { RISK_ORDER, type HazardKind, type RiskClass } from '@/lib/types';

/**
 * Derived local hazard exposure, painted on the ground.
 *
 * WHY THIS LAYER EXISTS. Bhuvan's flood and cyclone layers are national
 * products: over a 1.2 km AOI they return a single polygon, so the WMS
 * overlay alone washes the whole neighbourhood one flat colour and cannot say
 * which streets are worse than which. scripts/hazard.py grades every building
 * from the project's own DEM -- low ground, local hollows, distance to the
 * coast, wind exposure -- and this draws that grading as coloured ground, so
 * the AOI reads as areas of differing exposure instead of a uniform wash.
 *
 * The Bhuvan zone stays underneath and keeps its credit. This is DERIVED, and
 * the Legend key says so in those words.
 *
 * Parcels rather than footprints: a parcel tiles the ground, so the classes
 * form contiguous areas the eye reads as zones, and the patch is not hidden
 * beneath the building it describes. A parcel takes the WORST class among its
 * buildings -- a parcel is at the risk of the worst-placed thing on it.
 *
 * ONE GroundPrimitive, NOT 325 entities. A clamped entity polygon becomes its
 * own classification primitive; building them in a loop blocked the main
 * thread long enough for the tab to stop answering. Batched geometry
 * instances with a per-instance colour are the path Cesium provides for
 * exactly this, and they compile off the critical path.
 *
 * Colour is per instance rather than per material, so the four classes cost
 * one draw call between them. There is no outline: Cesium cannot outline a
 * ground-clamped polygon and logs a warning every frame if asked.
 *
 * Render-only: reads the store, writes nothing, moves no camera.
 */
export default function HazardRiskLayer() {
  const { viewer, ready } = useViewer();
  const parcels = useDataStore((s) => s.parcels);
  const buildings = useDataStore((s) => s.buildings);
  const showFlood = useViewStore((s) => s.layers.bhuvanFlood);
  const showCyclone = useViewStore((s) => s.layers.bhuvanCyclone);
  const photoreal = useViewStore((s) => s.buildingStyle) === 'photoreal';

  /**
   * Which hazard the ground shows, or null.
   *
   * One at a time by construction: two four-class ramps in the same hues on
   * the same ground would be unreadable, and the key names a single hazard.
   * Flood wins when both toggles are on, and the Legend says which is drawn.
   */
  const kind: HazardKind | null = showFlood ? 'flood' : showCyclone ? 'cyclone' : null;

  /** parcel id -> worst class among the buildings standing on it. */
  const byParcel = useMemo(() => {
    const out = new Map<number, RiskClass>();
    if (!kind || !buildings) return out;
    const key = kind === 'flood' ? 'flood_risk' : 'cyclone_risk';
    for (const f of buildings.features) {
      const cls = f.properties[key] as RiskClass | null | undefined;
      if (!cls) continue;
      const prev = out.get(f.properties.parcel_id);
      if (!prev || RISK_ORDER.indexOf(cls) > RISK_ORDER.indexOf(prev)) {
        out.set(f.properties.parcel_id, cls);
      }
    }
    return out;
  }, [kind, buildings]);

  useEffect(() => {
    if (!viewer || !ready || viewer.isDestroyed()) return undefined;
    if (!kind || !parcels || byParcel.size === 0) return undefined;

    const instances: Cesium.GeometryInstance[] = [];
    for (const f of parcels.features) {
      const cls = byParcel.get(f.properties.id);
      if (!cls) continue;
      const ring = (f.geometry.coordinates as number[][][])[0];
      const flat: number[] = [];
      for (const [lon, lat] of ring) flat.push(lon, lat);
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(flat),
          ),
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(RISK_COLOR[cls]),
        },
        id: `hazard-${kind}-${f.properties.id}-${cls}`,
      }));
    }
    if (instances.length === 0) return undefined;

    const primitive = new Cesium.GroundPrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
      // BOTH, not TERRAIN, for the reason ParcelsLayer gives: in Photoreal mode
      // the globe surface is hidden and the ground the user sees is Google's
      // mesh, so a TERRAIN-only classification would drape onto a surface that
      // is not being drawn.
      classificationType: Cesium.ClassificationType.BOTH,
      // Not interactive: the building underneath is what a click should select.
      allowPicking: false,
      asynchronous: true,
    });
    // Names the primitive for the acceptance probes, the way __ulpinViewer
    // names the viewer. A production build minifies constructor names, so
    // "is the grading on screen" has no other answer from outside.
    (primitive as Cesium.GroundPrimitive & { ulpinHazard?: HazardKind }).ulpinHazard = kind;
    viewer.scene.primitives.add(primitive);
    // The scene only redraws on demand and the primitive compiles
    // asynchronously, so poll `ready` and ask for the frame that shows it.
    // Without this the patches appear on the next unrelated interaction
    // instead of when they are built. Cesium 1.126 removed readyPromise.
    let poll = 0;
    const tick = () => {
      if (viewer.isDestroyed()) return;
      if (primitive.ready) { viewer.scene.requestRender(); return; }
      if (poll++ > 200) return;   // ~10 s, then stop asking
      timer = setTimeout(tick, 50);
    };
    let timer = setTimeout(tick, 50);
    viewer.scene.requestRender();

    return () => {
      clearTimeout(timer);
      if (!viewer.isDestroyed()) viewer.scene.primitives.remove(primitive);
    };
  }, [viewer, ready, kind, parcels, byParcel]);

  // Photoreal draws Google's mesh over the globe; the grading still classifies
  // onto it (ClassificationType.BOTH), so nothing is toggled here. Referenced
  // so the dependency is explicit rather than accidentally absent.
  void photoreal;

  return null;
}
