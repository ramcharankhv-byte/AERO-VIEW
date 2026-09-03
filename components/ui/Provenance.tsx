'use client';

import { PROVENANCE_HEX, PROVENANCE_SWATCH } from '@/lib/cesium/materials';
import { PROVENANCE_IS_AUTHORITATIVE, PROVENANCE_LABEL } from '@/lib/ulpin';
import type { Provenance } from '@/lib/types';

/**
 * The provenance line that every entity in the DetailPanel carries.
 *
 * Distinguishing surveyed data from estimated data is the point of the system,
 * so this is not decoration: an estimate is labelled an estimate, and a
 * "surveyed" value that came from a register which declared itself synthetic
 * says so rather than borrowing the authority of a real survey.
 */

/**
 * The blanket caveat for the synthetic building register.
 *
 * Deliberately says which fields are real as well as which are not: a note
 * that only admits to fabrication leaves the user unsure whether the storey
 * count they are about to act on was invented too.
 */
export const MOCK_BUILDING_NOTE =
  'Building name, type, built-up area, occupancy, owner and status are '
  + 'synthetic demonstration values generated from the building id — rows '
  + 'marked "demo". Storeys, height, ULPIN, footprint and coordinates are '
  + 'real. Names and addresses mapped in OpenStreetMap are shown unchanged '
  + 'and marked "osm".';

export const DERIVED_PARCEL_NOTE =
  'Derived boundary — Voronoi plot around clustered OSM footprints. '
  + 'Not a surveyed cadastral boundary.';

export function ProvenanceBadge({
  source,
  synthetic = false,
}: {
  source: Provenance;
  synthetic?: boolean;
}) {
  const authoritative = PROVENANCE_IS_AUTHORITATIVE[source] && !synthetic;
  return (
    <span
      className={[
        'chip inline-flex items-center gap-1.5 border',
        // Authority was previously visible only in the `title` attribute --
        // i.e. only to a user who hovered. With hue gone it becomes a visible
        // state instead: a solid rim is a source you may rely on, a dashed one
        // is not. That is the distinction this component exists to draw.
        authoritative
          ? 'border-[rgb(var(--edge-strong))] text-[rgb(var(--ink))]'
          : 'border-dashed border-[rgb(var(--edge-strong))] text-[rgb(var(--muted))]',
      ].join(' ')}
      style={{ background: 'rgb(var(--surface-2))' }}
      title={
        authoritative
          ? 'Authoritative source'
          : 'Not authoritative — do not rely on this value'
      }
    >
      {/* The mark is drawn in the provenance value via `currentColor`, so the
          swatch and the label always agree. See .swatch-* in globals.css. */}
      <span
        className={`swatch h-2 w-2 ${PROVENANCE_SWATCH[source]}`}
        style={{ color: PROVENANCE_HEX[source], borderColor: 'transparent' }}
        aria-hidden
      />
      {PROVENANCE_LABEL[source] ?? source}
      {synthetic ? ' (demo)' : ''}
    </span>
  );
}

/** Full provenance row: badge plus the caveat that applies to it. */
export function ProvenanceRow({
  source,
  synthetic = false,
  note,
}: {
  source: Provenance;
  synthetic?: boolean;
  note?: string;
}) {
  const caveat = (() => {
    if (note) return note;
    if (synthetic) {
      return 'Storey count came from a register that declares itself synthetic '
        + 'demonstration data. Not a real survey.';
    }
    switch (source) {
      case 'osm_tag':
        return 'Height mapped in OpenStreetMap by a contributor.';
      case 'surveyed_plan':
        return 'Storey count from an approved plan / field survey.';
      case 'dsm_dem':
        return 'Height differenced from a DSM/DEM raster pair.';
      case 'estimated':
      default:
        return 'Inferred from footprint area and building tag. Indicative only — '
          + 'not a measurement.';
    }
  })();

  return (
    <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="row-label">Provenance</span>
        <ProvenanceBadge source={source} synthetic={synthetic} />
      </div>
      <p className="mt-1 text-[10px] leading-snug text-[rgb(var(--muted))]">{caveat}</p>
    </div>
  );
}
