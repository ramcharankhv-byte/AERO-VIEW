'use client';

import { useState } from 'react';
import { DISCLAIMER, parse } from '@/lib/ulpin';

/**
 * The ULPIN card.
 *
 * Renders the identifier broken into its segments so the hierarchy is legible,
 * and carries the disclaimer inline -- not in a tooltip -- because presenting an
 * invented identifier in the visual language of a government one, without
 * saying so, is precisely the failure mode worth avoiding here.
 */

const SEGMENT_LABELS = ['State', 'District', 'Scheme', 'Parcel', 'Bldg', 'Floor', 'Unit'];

export default function UlpinCard({ ulpin }: { ulpin: string }) {
  const [copied, setCopied] = useState(false);
  const parts = parse(ulpin);
  const segments = ulpin.split('-');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ulpin);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked; the identifier is selectable on screen anyway */
    }
  };

  return (
    <div className="glass-soft rounded-md p-2.5">
      <div className="flex items-center justify-between">
        <span className="panel-title">ULPIN</span>
        <button
          type="button"
          onClick={copy}
          className="rounded px-1.5 py-0.5 text-[10px] text-[rgb(var(--muted))] hover:bg-white/10 hover:text-[rgb(var(--ink))]"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-end gap-x-1 gap-y-1 font-mono text-[13px] leading-none text-[rgb(var(--ink))]">
        {segments.map((seg, i) => (
          <span key={`${seg}-${i}`} className="flex flex-col items-center gap-0.5">
            <span className="text-[8px] uppercase tracking-wide text-[rgb(var(--muted))]">
              {SEGMENT_LABELS[i] ?? ''}
            </span>
            <span
              className={
                i >= 3
                  ? 'rounded bg-[rgb(var(--accent))]/15 px-1 py-0.5 text-[rgb(var(--accent))]'
                  : 'px-0.5 py-0.5'
              }
            >
              {seg}
            </span>
          </span>
        ))}
      </div>

      {parts ? (
        <div className="mt-1.5 text-[10px] text-[rgb(var(--muted))]">
          parcel {parts.parcel}
          {parts.building !== undefined ? ` · building ${parts.building}` : ''}
          {parts.floor !== undefined ? ` · level ${parts.floor}` : ''}
          {parts.unit !== undefined ? ` · unit ${parts.unit}` : ''}
        </div>
      ) : null}

      <p className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-1.5 text-[9px] leading-snug text-amber-300/80">
        {DISCLAIMER}
      </p>
    </div>
  );
}
