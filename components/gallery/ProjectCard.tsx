import Link from 'next/link';
import type { Project, ProjectStatus } from '@/lib/types';
import BboxSketch, { bboxExtentLabel } from './BboxSketch';

/**
 * One project, as a directory entry.
 *
 * Every class here is one the chrome already defines -- `glass`, `panel-title`,
 * `chip`, `tint-hover`, and the ink/muted/edge tokens. Nothing new is authored,
 * and no hue is introduced: scripts/shoot.mjs reads the computed styles of
 * everything inside a `.glass` back and reports any chroma that is not the
 * sanctioned `--danger`, and this card is inside one.
 *
 * `--danger` is used in exactly one place: the chip of a project whose
 * generation failed. That is the sanctioned use -- a state the user must not
 * miss -- and it is the same token the conflict count in the StatusBar uses.
 */
export default function ProjectCard(
  { project, demo = false }: { project: Project; demo?: boolean },
) {
  const s = project.stats;
  const openable = project.status === 'ready';

  const card = (
    <div className="glass flex h-full flex-col gap-3 rounded-lg p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold text-ink">{project.name}</h2>
          <p className="row-label truncate font-mono">
            {project.state_code}-{project.district_code}-{project.scheme_code}
            {' · '}
            {project.slug}
          </p>
        </div>
        <StatusChip status={project.status} />
      </div>

      <BboxSketch project={project} />

      <p className="row-label">
        {bboxExtentLabel(project)}
        {' · '}
        {project.bbox.map((v) => v.toFixed(4)).join(', ')}
      </p>

      <p className="text-[11px] leading-relaxed text-muted">
        {s
          ? [
            `${fmt(s.buildings)} buildings`,
            `${fmt(s.parcels)} parcels`,
            `${fmt(s.streets)} streets`,
            `${fmt(s.floors)} floors`,
            `${fmt(s.units)} units`,
            `${fmt(s.utilities)} utility runs`,
            `${fmt(s.conflicts)} conflicts`,
          ].join(' · ')
          : 'No entity counts yet — this project has not been exported.'}
      </p>

      <div className="mt-auto flex items-baseline justify-between gap-2 border-t border-edge pt-2">
        <span className="row-label">{formatDate(project.created_at)}</span>
        {demo ? (
          <span className="row-label" title="Served from the committed snapshots in data/api/siripuram/, so it opens with the database stopped">
            Demo · works offline
          </span>
        ) : null}
      </div>
    </div>
  );

  // A project that cannot be opened is not a link. Rendering it as one and
  // then landing the user on an error page is worse than saying so here.
  if (!openable) {
    return <div className="opacity-70">{card}</div>;
  }

  return (
    <Link
      href={`/p/${project.slug}`}
      className="tint-hover block rounded-lg focus-visible:outline-none"
      aria-label={`Open ${project.name}`}
    >
      {card}
    </Link>
  );
}

const fmt = (n: number) => n.toLocaleString('en-IN');

/**
 * Deterministic and locale-independent.
 *
 * `toLocaleDateString` would render differently on the server and in the
 * browser whenever the two disagree about locale or time zone, which React
 * reports as a hydration mismatch. The date is built from the UTC parts.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: 'Draft',
  generating: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
};

function StatusChip({ status }: { status: ProjectStatus }) {
  // Grey by default; the one hue is reserved for the one state that is a
  // problem, which is the same rule the rest of the chrome follows.
  const tone = status === 'failed'
    ? 'border-danger text-dangerInk'
    : status === 'ready'
      ? 'border-edgeStrong text-ink'
      : 'border-edge text-muted';
  return (
    <span className={`chip flex-none border ${tone}`}>{STATUS_LABEL[status]}</span>
  );
}
