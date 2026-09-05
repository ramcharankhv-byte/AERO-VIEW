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
  | 'parcels' | 'buildings' | 'roads' | 'floors' | 'utilities' | 'terrain' | 'basemap';

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
  unit_no: string;
  level_no: number;
  z_min: number;
  z_max: number;
  ring: Ring;
  /**
   * Set on a flat the caller may see but may not inspect.
   *
   * A citizen is shown their whole building -- the tower, its storeys, and
   * the shape of every flat on the floor -- but the register behind a
   * neighbour's door is not theirs to read. Such a unit arrives carrying its
   * GEOMETRY and nothing else: no ULPIN, no owner, no areas, no tenure. The
   * server strips them (filterDetailForCaller); this flag is what the viewer
   * reads to keep the volume on screen and out of the pick.
   *
   * The fields below are therefore optional for exactly this reason, and a
   * missing one means "not disclosed", never "zero".
   */
  restricted?: boolean;
  ulpin?: string;
  carpet_m2?: number;
  built_m2?: number;
  tenure?: string;
  encumbrance?: string;
  /**
   * Who holds this flat, where it is, and which way it looks.
   *
   * Optional because only the demo tower carries them: the OSM-derived
   * buildings have no per-unit register behind them, and inventing one would
   * be presenting a guess as a record. A flat without an owner is displayed
   * as unknown, not as the parcel's owner -- which is what the panel used to
   * do, attributing every flat in a tower to the developer.
   */
  owner?: string;
  address?: string;
  facing?: string;
}

export interface BuildingDetail {
  building: EnrichedBuilding & { footprint: Ring };
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

export interface GeoFeature<P = object> {
  type: 'Feature';
  id?: number | string;
  geometry: GeoGeometry;
  properties: P;
}

export interface GeoFC<P = object> {
  type: 'FeatureCollection';
  features: GeoFeature<P>[];
  /** The project's name. Written by the buildings query on both backends. */
  aoi?: string;
  /**
   * Present on collections that are DERIVED rather than sourced -- streets,
   * and any collection served empty because its artefact is missing. Read by
   * scripts/check_roads.mjs, which asserts the derivation is disclosed on the
   * wire and not only in a comment.
   */
  _disclaimer?: string;
}

// ---------------------------------------------------------------------------
// Projects.
//
// One project is one AOI. It carries the bbox the viewer frames, the revenue
// codes its ULPINs are minted under (see lib/ulpin.ts), and a status the
// gallery renders. Mirrors the `projects` table in db/01_schema.sql and the
// committed registry snapshot in data/api/projects.json, which are the two
// places this type is read from.
// ---------------------------------------------------------------------------

export type ProjectStatus = 'draft' | 'generating' | 'ready' | 'failed';

/**
 * Entity counts, denormalised onto the project row by 05_export_static.py.
 *
 * `streets` is not a database count: there is no road table, so it is the
 * length of the derived data/api/<slug>/roads.json, and it is 0 for a project
 * whose street artefact has not been built.
 */
export interface ProjectStats {
  buildings: number;
  parcels: number;
  streets: number;
  floors: number;
  units: number;
  utilities: number;
  conflicts: number;
}

export interface Project {
  slug: string;
  name: string;
  /** west, south, east, north — the same order scripts/ and the CLI use. */
  bbox: [number, number, number, number];
  state_code: string;
  district_code: string;
  scheme_code: string;
  status: ProjectStatus;
  /** ISO 8601, UTC. */
  created_at: string;
  /** Null until the project has been exported at least once. */
  stats: ProjectStats | null;
}

// ---------------------------------------------------------------------------
// Streets and roads.
//
// Centrelines come from the same OSM extract as the buildings
// (data/raw_highways.geojson, fetched by scripts/01_fetch_osm.py). The
// geometry and the `name` tag are REAL, surveyed by OSM contributors. The
// street id, the merged length, and the label given to a street OSM never
// named are DERIVED by scripts/build_roads.mjs, and `name_source` says which
// of the two any given name is -- the same discipline height_source applies to
// building heights.
//
// footway is deliberately excluded: 49 of them, none named, most under 40 m.
// They are pavements and park paths rather than addressable streets, and
// carrying them would mean inventing a name for each one to no cadastral end.
// ---------------------------------------------------------------------------

export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary'
  | 'residential' | 'unclassified' | 'living_street' | 'service';

/**
 * Where a street's NAME came from.
 *
 * Deliberately not the `Provenance` union: that one mirrors the height_source
 * CHECK constraint in db/01_schema.sql and must not be widened to describe
 * something the database has no column for.
 */
export type RoadNameSource = 'osm_name' | 'derived';

export interface RoadProps {
  /** Stable 1..N, frozen in data/api/roads.json. Numeric because EntityTag.id is. */
  id: number;
  /** Display identifier, e.g. "STR-001". This viewer's own reference. */
  ref: string;
  /** Never empty. See name_source for whether it is OSM's or ours. */
  name: string;
  /** The second half of an OSM "A;B" name, kept rather than discarded. */
  alt_name: string | null;
  name_source: RoadNameSource;
  /** The named street a derived name was anchored to. */
  derived_from: string | null;
  cls: RoadClass;
  /** Geodesic length over every merged part, metres. */
  length_m: number;
  /** How many OSM ways were merged into this street. */
  segments: number;
  osm_ids: number[];
  oneway: boolean;
  lanes: number | null;
  surface: string | null;
}

// ---------------------------------------------------------------------------
// Register attributes attached to a building by lib/mock/.
//
// SYNTHETIC DEMONSTRATION VALUES, generated deterministically from the building
// id so that a register-style record exists to show and to edit. They are not
// derived from any survey and the DetailPanel says so, per field.
//
// The sourced fields -- footprint, height_m, floors, basements, ulpin,
// parcel_id, osm_id, use_type, height_source -- are NEVER overwritten by that
// generator. Neither is a real OSM `name` or `address`: 59 of the 384
// buildings carry a name a contributor actually mapped and 6 carry a real
// address, and overwriting mapped fact with a plausible invention is precisely
// the confusion this application exists to prevent. name_source and
// address_source record which of the two any given value is.
//
// Kept as its own interface, and merged in as Partial, so that every consumer
// already handles the un-enriched case: deleting lib/mock/ and the one call
// site in lib/db.ts returns the application to sourced-data-only with no
// component churn at all.
// ---------------------------------------------------------------------------

export type BuildingStatus =
  | 'Occupied' | 'Partially occupied' | 'Vacant'
  | 'Under construction' | 'Under renovation';

/** Whether a value was mapped by an OSM contributor or generated here. */
export type ValueSource = 'osm_tag' | 'generated';

export interface BuildingMock {
  /** Display identifier, e.g. "BLD-1193". Derived from the real id. */
  building_ref: string;
  /** Descriptive type within the real use_type, e.g. "Apartment tower". */
  building_type: string;
  /** Total built-up area, m2. Summed from the real unit areas where known. */
  built_up_m2: number;
  /** Occupied units, and the real total the fraction was applied to. */
  occupancy_units: number;
  occupancy_total_units: number;
  /** Residents. Residential buildings only; null elsewhere. */
  occupancy_persons: number | null;
  owner_org: string;
  status: BuildingStatus;
  /** Footprint centroid. DERIVED FROM REAL GEOMETRY, and read-only in the UI. */
  lat: number;
  lon: number;
  name_source: ValueSource;
  address_source: ValueSource;
  /** Present iff lib/mock/ touched this record. */
  mock: true;
}

/**
 * A building as the API actually serves it.
 *
 * Partial, deliberately: the generator can be switched off, and a consumer
 * that assumed these fields were always present would then break. Every
 * reader already handles absence through the panel's own `?? '—'` idiom.
 */
export type EnrichedBuilding = BuildingProps & Partial<BuildingMock>;
