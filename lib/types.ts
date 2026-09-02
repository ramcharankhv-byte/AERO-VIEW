// Shared domain types. Names follow the LADM-inspired schema in db/01_schema.sql.

/** How a value was arrived at. Surfaced on every entity in the DetailPanel --
 *  telling surveyed fact from estimate is the point of the system. */
export type Provenance = 'osm_tag' | 'estimated' | 'dsm_dem' | 'surveyed_plan';

export type UseType = 'residential' | 'commercial' | 'institutional' | 'industrial';
export type AssetType = 'water' | 'sewer' | 'power' | 'metro';

/** The four view states of the single Cesium scene. Never a page navigation. */
export type Mode = 'city' | 'building' | 'floor' | 'unit';

/**
 * How buildings are drawn.
 *
 * 'schematic' is the cadastral view: our own extrusions, textured and
 * provenance-tagged, and the only mode in which the vertical stack is real
 * geometry. 'photoreal' drapes Google's captured mesh over the same AOI --
 * useful for orientation, but it carries no rights information, so the
 * schematic extrusions stay in the scene underneath it purely to be picked.
 */
export type BuildingStyle = 'schematic' | 'photoreal';

/**
 * Section-cut state for the active building.
 *
 * `axis` is the direction the cutting plane's normal points, in the local
 * metric frame: 'ew' opens an east-west section, 'ns' a north-south one.
 * `offset` is -100..100 across the footprint's own extent along that normal,
 * so one control reads the same on a 9 m house and a 60 m block.
 *
 * Mutually exclusive with explode: a stack that is both pulled apart and cut
 * through shows neither clearly, so the store enforces one or the other.
 */
export interface SliceState {
  enabled: boolean;
  axis: 'ns' | 'ew';
  offset: number;
}

export type LayerKey =
  | 'parcels' | 'buildings' | 'floors' | 'utilities' | 'terrain' | 'basemap';

export interface Ring {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface BuildingProps {
  id: number;
  ulpin: string;
  parcel_id: number;
  height_m: number;
  floors: number;
  basements: number;
  ground_elev: number;
  use_type: UseType;
  height_source: Provenance;
  /** True when height_source='surveyed_plan' but the register declared itself synthetic. */
  survey_synthetic: boolean;
  name: string | null;
  address: string | null;
  osm_id: number;
}

export interface ParcelInfo {
  id: number;
  ulpin: string;
  area_m2: number;
  owner: string;
  geometry?: Ring;
}

export interface FloorInfo {
  id: number;
  ulpin: string;
  level_no: number;
  z_min: number;
  z_max: number;
  detect_source: Provenance;
  ring: Ring;
}

export interface UnitInfo {
  id: number;
  floor_id: number;
  ulpin: string;
  unit_no: string;
  level_no: number;
  z_min: number;
  z_max: number;
  carpet_m2: number;
  built_m2: number;
  tenure: string;
  encumbrance: string;
  ring: Ring;
}

export interface BuildingDetail {
  building: BuildingProps & { footprint: Ring };
  parcel: ParcelInfo | null;
  floors: FloorInfo[];
  units: UnitInfo[];
}

export interface UtilityProps {
  id: number;
  asset_type: AssetType;
  depth_m: number;
  radius_m: number;
  authority: string;
  status: string;
  in_conflict: boolean;
}

export interface ConflictRow {
  id: number;
  kind: string;
  detected_at: string;
  utility_id: number;
  asset_type: AssetType;
  authority: string;
  status: string;
  depth_m: number;
  floor_id: number;
  floor_ulpin: string;
  level_no: number;
  building_id: number;
  building_ulpin: string;
  building_name: string | null;
}

/** A row of the vertical stack returned by POST /api/query. */
export interface StackHit {
  level: 'parcel' | 'building' | 'floor' | 'unit';
  id: number;
  ulpin: string;
  label: string;
  z_min: number | null;
  z_max: number | null;
  provenance: Provenance | null;
}

// Minimal GeoJSON shapes. Declared locally rather than depending on
// @types/geojson so the project has no ambient-type dependency.
export interface GeoGeometry {
  type: string;
  coordinates: unknown;
}

export interface GeoFeature<P = Record<string, unknown>> {
  type: 'Feature';
  id?: number | string;
  geometry: GeoGeometry;
  properties: P;
}

export interface GeoFC<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: GeoFeature<P>[];
  aoi?: string;
}
