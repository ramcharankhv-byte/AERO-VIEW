import '@/lib/cesium/base-url';
import type * as Cesium from 'cesium';

/**
 * How layers label the entities they create so the Picker can identify what was
 * clicked without string-parsing entity ids.
 *
 * Plain fields on the Entity rather than a Cesium PropertyBag: picking happens
 * on every mouse move, and reading a ConstantProperty needs a JulianDate and an
 * allocation per read.
 */
export interface EntityTag {
  kind:
    | 'parcel' | 'building' | 'road' | 'floor' | 'unit' | 'utility' | 'infra'
    /**
     * A survey parcel in the 2D GIS view.
     *
     * A SEPARATE KIND from 'parcel', not a reuse of it. The two layers draw
     * different polygons from different tables with different ids, and they
     * are on screen at different times; one kind would mean the Picker
     * resolving a click to whichever id happened to be tagged, and selecting
     * the wrong plot in the wrong table is a silent error that looks correct.
     */
    | 'surveyParcel';
  id: number;
  /**
   * The component's own identifier, for 'infra' only.
   *
   * An infrastructure component is identified by a string -- TTF-P-014 -- and
   * `id` is a number, so the layer mints a numeric pick handle and carries the
   * real identifier alongside it. Not a hash of the ref: a collision would
   * select the wrong pillar, and a counter cannot collide.
   */
  ref?: string;
  /**
   * level_no, for floor AND unit entities.
   *
   * A unit carries it because a flat can be clicked on the exploded stack while
   * its level is not the isolated one; the Picker needs the level to open both
   * in a single store write rather than isolating and then selecting.
   */
  level?: number;
}

export type TaggedEntity = Cesium.Entity & { tag?: EntityTag };

export function tagEntity(entity: Cesium.Entity, tag: EntityTag): Cesium.Entity {
  (entity as TaggedEntity).tag = tag;
  return entity;
}

export function tagOf(picked: unknown): EntityTag | null {
  if (!picked || typeof picked !== 'object') return null;
  const id = (picked as { id?: unknown }).id;
  const entity = (id && typeof id === 'object' ? id : picked) as TaggedEntity;
  return entity.tag ?? null;
}
