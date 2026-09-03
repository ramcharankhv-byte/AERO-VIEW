'use client';

import { useMemo } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import {
  conflictsByAuthority, heightHistogram, provenanceMix, useTypeCounts,
} from '@/lib/stats';

/**
 * The mini-dashboard: three charts over the cadastre already in memory.
 *
 * Every figure and every caption is computed from the loaded FeatureCollections
 * -- nothing here is written down. The boot fetch loads buildings, parcels,
 * utilities and conflicts together, so this panel never fetches anything.
 *
 * The bars are hand-rolled SVG. There is no chart library in this project and
 * three bar charts are not a reason to add one.
 */

const BAR_W = 168;
const ROW_H = 15;

function Bars({
  rows,
  format,
}: {
  rows: Array<{ key: string; count: number }>;
  format?: (r: { key: string; count: number }) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${BAR_W} ${rows.length * ROW_H}`}
      className="mt-1 text-[rgb(var(--ink))]"
      role="img"
    >
      {rows.map((r, i) => (
        <g key={r.key} transform={`translate(0 ${i * ROW_H})`}>
          <rect
            x={0}
            y={3}
            width={Math.max(r.count > 0 ? 1 : 0, (r.count / max) * (BAR_W - 46))}
            height={8}
            rx={1.5}
            fill="currentColor"
            opacity={0.75}
          />
          <text x={BAR_W} y={11} textAnchor="end" fontSize={9} fill="rgb(var(--muted))">
            {format ? format(r) : r.count}
          </text>
        </g>
      ))}
    </svg>
  );
}

function Chart({
  title,
  caption,
  labels,
  children,
}: {
  title: string;
  caption: string;
  labels: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 border-t border-[rgb(var(--edge))]/50 pt-2 first:mt-0 first:border-t-0 first:pt-0">
      <div className="panel-title">{title}</div>
      <div className="flex gap-2">
        <div className="w-[86px] shrink-0 pt-1">
          {labels.map((l) => (
            <div
              key={l}
              className="h-[15px] truncate text-[9px] leading-[15px] text-[rgb(var(--ink))]"
              title={l}
            >
              {l}
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      <p className="mt-1 text-[9px] leading-snug text-[rgb(var(--muted))]">{caption}</p>
    </div>
  );
}

export default function StatsPanel() {
  const statsOpen = useViewStore((s) => s.statsOpen);
  const buildings = useDataStore((s) => s.buildings);
  const conflicts = useDataStore((s) => s.conflicts);

  const features = useMemo(() => buildings?.features ?? [], [buildings]);
  const heights = useMemo(() => heightHistogram(features, 8), [features]);
  const uses = useMemo(() => useTypeCounts(features), [features]);
  const authorities = useMemo(() => conflictsByAuthority(conflicts), [conflicts]);
  const mix = useMemo(() => provenanceMix(features), [features]);

  if (!statsOpen) return null;

  const heightRows = heights.map((b) => ({
    key: `${b.lo.toFixed(0)}-${b.hi.toFixed(0)}`,
    count: b.count,
  }));

  // The provenance caption is the same claim the Legend makes, phrased as the
  // share of the heights this chart is drawn from.
  const heightCaption = features.length === 0
    ? 'Heights: no buildings loaded.'
    : `Heights: ${mix.pct.osm_tag}% OSM-tagged, ${mix.pct.estimated}% estimated, `
      + `${mix.pct.surveyed_plan}% plan (${mix.synthetic} of those a demo register).`;

  return (
    <div data-panel="stats" className="glass pointer-events-auto max-h-full w-full overflow-y-auto rounded-lg p-3">
      <div className="text-[13px] font-semibold text-[rgb(var(--ink))]">
        Area statistics
      </div>

      <div className="mt-2">
        <Chart
          title="Building heights (m)"
          labels={heightRows.map((r) => `${r.key} m`)}
          caption={heightCaption}
        >
          <Bars rows={heightRows} />
        </Chart>

        <Chart
          title="Buildings by use type"
          labels={uses.map((u) => u.key)}
          caption={
            `${features.length} footprints classified by OSM building tag. `
            + 'Unit counts are not in this response — they need per-building detail.'
          }
        >
          <Bars rows={uses} />
        </Chart>

        <Chart
          title="Conflicts by authority"
          labels={authorities.map((a) => a.key)}
          caption={
            authorities.length === 0
              ? 'No conflicts detected.'
              : `${conflicts.length} basement encroachments from ST_3DIntersects, `
                + 'grouped by the utility owner of record.'
          }
        >
          <Bars rows={authorities} />
        </Chart>
      </div>
    </div>
  );
}
