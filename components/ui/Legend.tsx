'use client';

import { useState } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import { UTILITY_COLOR, UTILITY_LABEL } from '@/lib/cesium/materials';
import { PROVENANCES } from '@/lib/stats';
import type { AssetType } from '@/lib/types';
import { ProvenanceBadge } from './Provenance';

const DEPTHS: Record<AssetType, string> = {
  power: '-1.0 m',
  water: '-1.5 m',
  sewer: '-3.0 m',
  metro: '-14.0 m',
};

/**
 * The colour keys: provenance always, utility corridors underground.
 *
 * The provenance key is not gated on a selection. Which heights were surveyed
 * and which were guessed is the point of the system, so the badge language has
 * to be readable before the user has clicked anything -- otherwise the colours
 * on screen are a code with no key.
 */
export default function Legend() {
  const underground = useViewStore((s) => s.underground);
  const mode = useViewStore((s) => s.mode);
  const utilities = useDataStore((s) => s.utilities);
  const buildings = useDataStore((s) => s.buildings);

  // Local, not store state: this is a disclosure toggle on one panel, with no
  // bearing on the scene and nothing else to coordinate with.
  //
  // Null means "follow the mode": open in city view, where the key explains the
  // massing the user is looking at, and closed once a building is selected and
  // the DetailPanel is carrying the provenance instead. An explicit click wins
  // over that default from then on.
  const [override, setOverride] = useState<boolean | null>(null);
  const provenanceOpen = override ?? mode === 'city';

  const counts = new Map<string, number>();
  for (const f of utilities?.features ?? []) {
    const t = f.properties.asset_type as string;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  // Counted, not written down: the mix is a property of the loaded data.
  const provCounts = new Map<string, number>();
  let synthetic = 0;
  for (const f of buildings?.features ?? []) {
    const src = f.properties.height_source;
    provCounts.set(src, (provCounts.get(src) ?? 0) + 1);
    if (f.properties.survey_synthetic) synthetic++;
  }

  return (
    <div className="glass pointer-events-auto w-[186px] rounded-lg p-2.5">
      <button
        type="button"
        onClick={() => setOverride(!provenanceOpen)}
        aria-expanded={provenanceOpen}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="panel-title">Provenance key</span>
        <span className="text-[10px] text-[rgb(var(--muted))]">
          {provenanceOpen ? '−' : '+'}
        </span>
      </button>

      {provenanceOpen ? (
        <div className="mt-1.5 space-y-1">
          {PROVENANCES.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <ProvenanceBadge source={p} />
              <span className="ml-auto font-mono text-[10px] text-[rgb(var(--muted))]">
                {provCounts.get(p) ?? 0}
              </span>
            </div>
          ))}
          {/* Its own row because it is its own claim: the badge reads
              "Surveyed plan (demo)" and is not authoritative, which the plain
              surveyed_plan row above does not say. */}
          <div className="flex items-center gap-2">
            <ProvenanceBadge source="surveyed_plan" synthetic />
            <span className="ml-auto font-mono text-[10px] text-[rgb(var(--muted))]">
              {synthetic}
            </span>
          </div>
          <p className="pt-1 text-[9px] leading-snug text-[rgb(var(--muted))]">
            Counts are buildings by height source. Only OSM tag and Surveyed plan
            are authoritative.
          </p>
        </div>
      ) : null}

      {underground ? (
        <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
          <div className="panel-title">Utility corridors</div>
          <div className="mt-1.5 space-y-1">
            {(['water', 'sewer', 'power', 'metro'] as AssetType[]).map((t) => (
              <div key={t} className="flex items-center gap-2">
                <span
                  className="h-2 w-4 shrink-0 rounded-full"
                  style={{ background: UTILITY_COLOR[t].toCssColorString() }}
                />
                <span className="flex-1 text-[11px] text-[rgb(var(--ink))]">
                  {UTILITY_LABEL[t]}
                </span>
                <span className="font-mono text-[10px] text-[rgb(var(--muted))]">
                  {DEPTHS[t]}
                </span>
                <span className="w-6 text-right font-mono text-[10px] text-[rgb(var(--muted))]">
                  {counts.get(t) ?? 0}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 border-t border-[rgb(var(--edge))]/50 pt-2">
            <span className="pulse-conflict h-2 w-4 shrink-0 rounded-full bg-red-500" />
            <span className="text-[11px] text-red-300">Basement conflict</span>
          </div>
          <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
            Alignments derived from road centrelines, not as-built utility records.
          </p>
        </div>
      ) : null}
    </div>
  );
}
