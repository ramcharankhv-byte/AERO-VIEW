'use client';

import { useViewStore } from '@/lib/store';

/**
 * Names the findings from a Topology Validation run.
 *
 * Replaces the old ConflictBanner, which named the seeded `conflict` table's
 * one fixed question (a utility through a basement, found once at seed time).
 * This is the live, broader check -- clashes, clearance breaches, airspace
 * encroachments -- and it is now the ONLY place a conflict is announced:
 * Underground mode itself stays clear until someone asks the question.
 */
export default function TopologyBanner() {
  const findings = useViewStore((s) => s.topology.findings);
  const selectFinding = useViewStore((s) => s.selectFinding);
  const selected = useViewStore((s) => s.topology.selected);

  if (findings.length === 0) return null;

  // Critical (actual overlaps) before warnings (clearance breaches), then by
  // discovery order for stability -- same grouping TopologyFindings uses.
  const ordered = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ac = a.f.severity === 'critical' ? 0 : 1;
      const bc = b.f.severity === 'critical' ? 0 : 1;
      return ac - bc || a.i - b.i;
    });
  const lead = ordered[0].f;

  return (
    <div
      data-panel="topology"
      role="status"
      aria-live="polite"
      className="glass pointer-events-auto w-full max-w-[560px] rounded-lg border-danger/60 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="pulse-conflict inline-block h-2 w-2 shrink-0 rounded-full bg-danger" />
        <span className="text-[12px] font-semibold text-dangerInk">
          {findings.length} topology finding{findings.length > 1 ? 's' : ''} detected
        </span>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-wide text-[rgb(var(--muted))]">
          Topology validation
        </span>
      </div>

      <p className="mt-1 text-[11px] leading-snug text-[rgb(var(--ink))]">{lead.note}</p>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {ordered.slice(0, 8).map(({ f, i }) => (
          <button
            key={`${f.kind}-${String(f.a.id)}-${f.b.type}-${String(f.b.id)}`}
            type="button"
            aria-label={`Select finding: ${f.a.label} and ${f.b.label}`}
            onClick={() => selectFinding(selected === i ? null : i)}
            className={[
              'rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors',
              selected === i
                ? 'bg-danger text-white'
                : 'bg-danger/15 text-dangerInk hover:bg-danger/30',
            ].join(' ')}
          >
            {f.b.label}
          </button>
        ))}
        {ordered.length > 8 ? (
          <span className="px-1 py-0.5 text-[9px] text-[rgb(var(--muted))]">
            +{ordered.length - 8} more
          </span>
        ) : null}
      </div>
    </div>
  );
}
