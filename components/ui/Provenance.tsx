'use client';

import { PROVENANCE_HEX } from '@/lib/cesium/materials';
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
  const hex = PROVENANCE_HEX[source];
  const authoritative = PROVENANCE_IS_AUTHORITATIVE[source] && !synthetic;
  return (
    <span
      className="chip inline-flex items-center gap-1 border"
      style={{
        color: hex,
        borderColor: `${hex}66`,
        background: `${hex}14`,
      }}
      title={
        authoritative
          ? 'Authoritative source'
          : 'Not authoritative — do not rely on this value'
      }
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: hex }}
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
