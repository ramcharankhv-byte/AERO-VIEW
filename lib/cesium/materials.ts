import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import type { AssetType, Provenance, UseType } from '@/lib/types';

/**
 * Every colour state in the scene, defined once.
 *
 * ARCHITECTURE RULE: no component constructs its own Cesium.Color for entity
 * styling. If a new visual state is needed it is added here, so that "what does
 * gold mean" has exactly one answer in the codebase.
 */

const rgba = (r: number, g: number, b: number, a: number) =>
  Cesium.Color.fromBytes(r, g, b, Math.round(a * 255));

// ---------------------------------------------------------------- buildings
/** Base fill by use type -- muted, so highlights read clearly against them. */
export const USE_COLOR: Record<UseType, Cesium.Color> = {
  residential: rgba(122, 146, 178, 1),
  commercial: rgba(178, 150, 110, 1),
  institutional: rgba(132, 168, 150, 1),
  industrial: rgba(150, 140, 160, 1),
};

export const MATERIALS = {
  /** City mode: a normal, unselected building. */
  buildingDefault: (use: UseType, alpha = 0.92) =>
    USE_COLOR[use].withAlpha(alpha),

  /** Cursor is over it. */
  buildingHover: rgba(120, 205, 255, 1),

  /** Someone else's building while one is active -- faded right back. */
  buildingFaded: (use: UseType, alpha: number) => USE_COLOR[use].withAlpha(alpha),

  /** An above-ground floor slab in the exploded stack. */
  floorSlab: rgba(150, 190, 230, 0.34),

  /** The floor currently isolated. */
  floorActive: rgba(140, 215, 255, 0.55),

  /** Basements are solid grey -- they read as mass, not as habitable volume. */
  basementSlab: rgba(120, 124, 132, 0.95),

  /** Edge of a floor slab in the stack. */
  floorOutline: rgba(143, 180, 216, 0.5),

  /** A unit volume on the isolated floor. */
  unitDefault: rgba(196, 214, 236, 0.42),

  /** Edge of an unselected unit. */
  unitOutlineIdle: rgba(159, 182, 207, 0.45),

  /** The selected unit: gold, with a silhouette outline. */
  unitSelected: rgba(240, 190, 72, 0.88),
  unitOutline: rgba(255, 226, 140, 1),

  /** Surface parcel polygons, clamped to ground. */
  parcelFill: rgba(90, 170, 140, 0.16),
  parcelOutline: rgba(120, 210, 170, 0.85),
  parcelActive: rgba(150, 235, 190, 0.4),

  /** Architectural model on the active building. */
  buildingModelWall: rgba(238, 232, 220, 1),
  buildingModelRoof: (use: UseType) => USE_COLOR[use].withAlpha(0.96),
  buildingModelFixture: rgba(80, 84, 92, 1),
} as const;

// ---------------------------------------------------------------- utilities
export const UTILITY_COLOR: Record<AssetType, Cesium.Color> = {
  water: rgba(64, 158, 232, 1),
  sewer: rgba(150, 112, 74, 1),
  power: rgba(238, 186, 60, 1),
  metro: rgba(176, 108, 220, 1),
};

export const UTILITY_LABEL: Record<AssetType, string> = {
  water: 'Water main',
  sewer: 'Sewer',
  power: 'Power duct',
  metro: 'Metro tunnel',
};

/** A utility corridor the user has picked. */
export const UTILITY_SELECTED = Cesium.Color.WHITE.withAlpha(0.95);

/** Conflicting segments pulse between these two. */
export const CONFLICT_COLOR = rgba(255, 64, 64, 0.95);
export const CONFLICT_COLOR_DIM = rgba(150, 24, 24, 0.55);

// --------------------------------------------------------------- provenance
/** Estimated data is visually distinct from surveyed data throughout the UI. */
export const PROVENANCE_HEX: Record<Provenance, string> = {
  surveyed_plan: '#4ade80',
  osm_tag: '#38bdf8',
  dsm_dem: '#a78bfa',
  estimated: '#fbbf24',
};

/** Canvas clear colour behind the globe. */
export const SCENE_BACKGROUND = Cesium.Color.fromCssColorString('#05080f');

/** A circular cross-section for PolylineVolume tubes. */
export function tubeShape(radius: number, sides = 12): Cesium.Cartesian2[] {
  const pts: Cesium.Cartesian2[] = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Cesium.Math.TWO_PI;
    pts.push(new Cesium.Cartesian2(radius * Math.cos(t), radius * Math.sin(t)));
  }
  return pts;
}
