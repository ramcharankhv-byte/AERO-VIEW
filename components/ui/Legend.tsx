'use client';

import { useDataStore, useViewStore } from '@/lib/store';
import { UTILITY_COLOR, UTILITY_LABEL } from '@/lib/cesium/materials';
import type { AssetType } from '@/lib/types';

const DEPTHS: Record<AssetType, string> = {
  power: '-1.0 m',
  water: '-1.5 m',
  sewer: '-3.0 m',
  metro: '-14.0 m',
};

/** Utility colour key, shown only in underground mode. */
export default function Legend() {
  const underground = useViewStore((s) => s.underground);
  const utilities = useDataStore((s) => s.utilities);
  if (!underground) return null;

  const counts = new Map<string, number>();
  for (const f of utilities?.features ?? []) {
    const t = f.properties.asset_type as string;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  return (
    <div className="glass pointer-events-auto w-[186px] rounded-lg p-2.5">
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
  );
}
