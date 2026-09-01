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
  kind: 'parcel' | 'building' | 'floor' | 'unit' | 'utility';
  id: number;
  /** level_no, for floor entities. */
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
