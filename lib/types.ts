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
  | 'parcels' | 'buildings' | 'roads' | 'floors' | 'utilities' | 'terrain' | 'basemap'
  // ISRO Bhuvan WMS context overlays. Offered only when the project's
  // bhuvan_layers block names the layer; off by default.
  | 'bhuvanLulc' | 'bhuvanFlood' | 'bhuvanCyclone';

/** Where a building's ground_elev came from. See scripts/dem.py. */
export type GroundSource = 'dsm_dem' | 'placeholder';

/**
 * Local hazard exposure, in increasing order. DERIVED from the DEM surface
 * and the coastline in the same tile by scripts/hazard.py -- never a reading
 * of an NRSC product. Bhuvan's own flood and cyclone layers are national and
 * cover an AOI this size with a single polygon, so they say nothing about
 * which streets are worse than which; this does, and says who computed it.
 */
export type RiskClass = 'low' | 'moderate' | 'high' | 'severe';
export const RISK_ORDER: RiskClass[] = ['low', 'moderate', 'high', 'severe'];
/** The hazards the derived index covers, matching the Bhuvan overlay kinds. */
export type HazardKind = 'flood' | 'cyclone';

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
  /**
   * 'dsm_dem' when ground_elev was sampled from the project's CartoDEM tile,
   * 'placeholder' when it is the 12.0 m default. Optional only because a
   * snapshot exported before the column existed lacks it; treat absent as
   * 'placeholder'.
   */
  ground_source?: GroundSource;
  /** Derived local exposure. Absent when the project has no DEM. */
  flood_risk?: RiskClass | null;
  cyclone_risk?: RiskClass | null;
  flood_score?: number | null;
  cyclone_score?: number | null;
  /** Metres to the nearest sea cell in the DEM; null when landlocked. */
  coast_dist_m?: number | null;
  /** Ground minus the local floor within 250 m. Negative = a hollow. */
  local_relief_m?: number | null;
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
  /**
   * The register entries behind the door: how the flat is held, the charge on
   * it if any, and whether its tax and bills are settled.
   *
   * Merged over the cadastre by `enrichBuildingDetail` from the project's
   * flat register (data/projects/<slug>/flat-register.json), so PostGIS and
   * the snapshot answer identically -- the cadastre stores geometry and
   * title, and the money is a separate record that both backends read from
   * the same file.
   *
   * Optional for the same reason as `owner`: only the demo tower has one.
   * A flat without a register entry shows its tenure and encumbrance and
   * says nothing it cannot support.
   */
  ownership?: OwnershipStatus;
  title_deed?: string;
  registered_on?: string;
  mortgage?: MortgageInfo;
  tax?: TaxInfo;
  bills?: BillInfo[];
}

/** Held outright, or held with a bank's charge on it. */
export type OwnershipStatus = 'owned' | 'mortgaged';

/** The bank's charge on a mortgaged flat. Dates are ISO yyyy-mm-dd. */
export interface MortgageInfo {
  bank: string;
  branch: string;
  loan_no: string;
  sanctioned_inr: number;
  outstanding_inr: number;
  emi_inr: number;
  charge_from: string;
  closes_on: string;
}

/** Municipal property tax for one assessment year. */
export interface TaxInfo {
  authority: string;
  assessment_no: string;
  /** Assessment year, e.g. "2026-27". */
  year: string;
  demand_inr: number;
  paid_inr: number;
  /** null when nothing has been paid against this demand. */
  paid_on: string | null;
  due_on: string;
}

/** One recurring service bill against the flat. */
export interface BillInfo {
  kind: 'water' | 'electricity' | 'maintenance';
  /** Who raises it -- GVMC, APEPDCL, the owners' association. */
  authority: string;
  account: string;
  /** Billing period as printed on the bill, e.g. "Aug 2026". */
  period: string;
  amount_inr: number;
  paid: boolean;
  due_on: string;
  paid_on: string | null;
}

/**
 * One flat's register entry, keyed by ULPIN in the project's flat register.
 * The fields are spread onto the matching `UnitInfo` on read.
 */
export interface FlatRegisterEntry {
  ownership: OwnershipStatus;
  title_deed: string;
  registered_on: string;
  mortgage?: MortgageInfo;
  tax?: TaxInfo;
  bills?: BillInfo[];
}

export interface BuildingDetail {
  building: EnrichedBuilding & { footprint: Ring };
  parcel: ParcelInfo | null;
  floors: FloorInfo[];
  units: UnitInfo[];
}

/**
 * One underground run, as the utilities endpoint serves it.
 *
 * `asset_type` is typed as a string rather than as `AssetType` because the two
 * have come apart on purpose. `AssetType` mirrors the CHECK constraint on
 * `utility.asset_type`, which db/migrations/004 widens; the DISPLAY taxonomy
 * is UtilityCategory in lib/underground/categories.ts, and
 * `categoryOfAssetType` is the one mapping between them. Typing this field as
 * the narrow union would make every consumer cast, which is exactly what the
 * call sites used to do.
 *
 * Everything below `in_conflict` is OPTIONAL and is rendered only when the
 * record carries it. That is the data-integrity rule in the type system: a
 * pipe whose material was never surveyed shows no material row, rather than a
 * plausible one.
 */
export interface UtilityProps {
  id: number;
  asset_type: string;
  depth_m: number;
  radius_m: number;
  authority: string;
  status: string;
  in_conflict: boolean;
  /** Set on a run that belongs to one building rather than to a street. */
  building_id?: number;
  /** Display identifier, e.g. "VSKP-WTR-004". Falls back to `#id`. */
  ref?: string;
  /** Nominal bore, millimetres. Not derivable from radius_m, which is the
   *  corridor buffer used for the 3D conflict test, not the pipe. */
  diameter_mm?: number;
  material?: string;
  /** What the run serves, in words. */
  connected_area?: string;
  /** ISO yyyy-mm-dd. */
  installed_on?: string;
  /**
   * How this record came to exist.
   *
   * 'demonstration' is not a hedge, it is a statement: no utility survey was
   * consulted, and the DetailPanel says so on the face of the card. A record
   * with no provenance is treated as 'estimated', which is what the
   * road-centreline offsets the pipeline generates actually are.
   */
  provenance?: 'demonstration' | 'estimated' | 'surveyed';
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
  /**
   * The building this hit belongs to, for `level` in {building, floor, unit}.
   * Null only for `parcel`, which is the level ABOVE the building. The field
   * is the join that lets a click on a flat tell the DetailPanel which
   * building the panel should describe -- without it, a PostGIS-resident
   * citizen could not tell where they had clicked: a unit id is opaque
   * across projects, the building id is not.
   *
   * Carried on every level rather than computed by the consumer because
   * that is the contract /api/query already publishes for building; the
   * floor and unit rows had no way to say it, and a panel that had to
   * look it up in a second query would race the very edit it was
   * describing.
   */
  building_id: number | null;
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
  /**
   * Rows in `survey_parcel`. OPTIONAL because every registry snapshot written
   * before that table existed omits it, and a project is not wrong for
   * predating a layer.
   */
  survey_parcels?: number;
  streets: number;
  floors: number;
  units: number;
  utilities: number;
  conflicts: number;
}

/** Where the project's ground elevations came from. */
export type ElevSource = 'cartodem_v3' | 'placeholder';

/**
 * ISRO Bhuvan WMS layer names for the optional context overlays, keyed by
 * what they show. A missing key is an overlay the project does not offer.
 */
export interface BhuvanLayers {
  lulc?: string;
  flood?: string;
  cyclone?: string;
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
  /**
   * 'cartodem_v3' when scripts/dem.py sampled an NRSC CartoDEM tile for this
   * AOI, 'placeholder' when every building carries the 12.0 m default.
   * Optional only for a registry snapshot written before the column existed.
   */
  elev_source?: ElevSource;
  /** Vertical datum of ground_elev: 'msl_egm96', or null for placeholders. */
  elev_datum?: string | null;
  /** Optional ISRO Bhuvan overlays. Null/absent: no "Context (ISRO)" group. */
  bhuvan_layers?: BhuvanLayers | null;
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
export type RoadNameSource =
  | 'osm_name'
  /** Named by scripts/build_roads.mjs, anchored to a street OSM did name. */
  | 'derived'
  /**
   * Named by a cited published source rather than by a mapper or by us.
   *
   * Added for the infrastructure sites, whose two arterials are named in the
   * reference the site spec cites. Neither of the other two values would be
   * true of them: nobody mapped these in OSM, and "derived" means we invented
   * the name -- which for Dondaparthi Road would be a plain falsehood, and the
   * exact confusion this field exists to prevent.
   */
  | 'reference';

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
