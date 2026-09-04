import type { BuildingProps, EnrichedBuilding } from '../types.ts';
import type { BuildingEdit } from '../data/building-schema.ts';

/**
 * Edit-overlay primitives, exported so the cached read path in
 * `lib/cache/store.ts` can apply the same overlay lib/db.ts would
 * have applied on the non-cached path.
 *
 * The functions here are byte-for-byte equivalent to the ones in
 * `lib/db.ts` (`preEnrich`, `postEnrich`). They live in a separate
 * module because lib/db.ts keeps them private to the file -- they're
 * an implementation detail of the enrichment pipeline, not part of
 * the module's public surface. The cached read path needs the
 * overlay but does not need the rest of db.ts's plumbing, so this
 * module exists as the smallest possible dependency that gives the
 * cache what it needs.
 *
 * If the real preEnrich / postEnrich semantics change -- a new
 * editable field, a different source tag for edited names -- the
 * functions here MUST change in lockstep. The decisions log records
 * this constraint; a unit test would be a good idea, but the
 * functions are five lines each and the type checker is enough.
 */

/** Fields the user is allowed to edit. The brief is "real schema" and
 *  these are the only fields the form can change on a building record.
 *  Must stay aligned with REAL_SCHEMA_FIELDS in lib/db.ts. */
const REAL_SCHEMA_FIELDS = ['name', 'address', 'floors', 'height_m'] as const;

/**
 * Apply an edit to the raw building properties BEFORE enrichment.
 *
 * The pre-enrichment step touches the same set of fields the building
 * register's own schema would write to: name, address, floors, height.
 * The enrichment pipeline is the thing that derives everything else
 * (footprint area, unit counts, nearest street, locality), and the
 * derived values need to be recomputed from the edited schema fields,
 * not from the as-postGIS values. So: edit the schema, THEN enrich.
 */
export function preEnrich(
  b: BuildingProps,
  edit: Partial<BuildingEdit> | null,
): BuildingProps {
  if (!edit) return b;
  // The spread turns BuildingProps into an open object, so a property
  // assignment is legal. The cast below is the same one lib/db.ts uses
  // for the in-place version; without it, the type checker refuses an
  // index access on a closed record.
  const out: Record<string, unknown> = { ...b };
  for (const f of REAL_SCHEMA_FIELDS) {
    if (edit[f] !== undefined) out[f] = edit[f];
  }
  // The output has every required BuildingProps field, because the
  // input did and REAL_SCHEMA_FIELDS only overwrites values that are
  // present. The double cast gets us past the structural type
  // checker's "missing properties" complaint.
  return out as unknown as BuildingProps;
}

/**
 * Apply an edit to the enriched building AFTER enrichment.
 *
 * The post-enrichment step reaches past the derived fields and
 * overwrites them with the user's edits if those edits named them
 * (so an edited built_up_m2 lands on the building even though
 * enrichment produced a number from the unit areas). It also
 * stamps name_source / address_source to 'generated' for any field
 * the user edited, because an edited name is no longer an OSM tag
 * nor an estimate -- it is the user's, and the panel needs to be
 * able to say so.
 */
export function postEnrich(
  b: EnrichedBuilding,
  edit: Partial<BuildingEdit> | null,
): EnrichedBuilding {
  if (!edit) return b;
  const out: EnrichedBuilding = { ...b, ...edit };
  if (edit.name !== undefined) out.name_source = 'generated';
  if (edit.address !== undefined) out.address_source = 'generated';
  return out;
}

export type { EnrichedBuilding };
