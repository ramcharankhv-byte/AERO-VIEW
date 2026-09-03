import type { Metadata } from 'next';
import { listProjects, DEFAULT_SLUG } from '@/lib/projects';
import ProjectCard from '@/components/gallery/ProjectCard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '3D ULPIN — Projects',
  description:
    'Every area of interest this viewer holds: parcel, building, floor and unit '
    + 'volumes with underground utility conflicts, one project per AOI.',
};

/**
 * The gallery.
 *
 * `/` renders this rather than redirecting to a project. A redirect would make
 * the browser's back button bounce off the viewer, and it would mean the
 * application had no page that says what it holds -- which, once there is more
 * than one AOI, is the first thing anyone needs.
 *
 * It is a server component and reads the registry directly, so it renders with
 * the database stopped: lib/projects.ts falls back to the committed
 * data/api/projects.json. That is the same guarantee the demo project's
 * cadastre already had, extended to the list of what exists.
 *
 * There is deliberately no "New project" affordance here, disabled or
 * otherwise. Generation is a command-line pipeline (`npm run seed --
 * --slug=…`), and a button that cannot do the thing it names is worse than no
 * button: the Measurements / Share / Split controls in the viewer are rendered
 * disabled because the brief asks for their absence to be explicit, which is a
 * different situation from inventing an entry point for a feature that does
 * not exist.
 */
export default async function GalleryPage() {
  const projects = await listProjects();

  return (
    <main className="h-dvh w-screen overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-full max-w-[1200px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-8">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="panel-title">3D ULPIN — Vertical Property Mapper</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">
              Projects
            </h1>
          </div>
          <p className="text-[11px] text-muted">
            {projects.length === 1 ? '1 area of interest' : `${projects.length} areas of interest`}
          </p>
        </header>

        <p className="max-w-2xl text-[12px] leading-relaxed text-muted">
          One project is one area of interest: a bounding box, the revenue codes
          its identifiers are minted under, and the cadastral stack built inside
          it. Identifiers are prefixed by state and district, so parcel 0001
          exists in every project and the prefix is what tells them apart.
        </p>

        {projects.length === 0 ? (
          <Empty />
        ) : (
          <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.slug}>
                <ProjectCard project={p} demo={p.slug === DEFAULT_SLUG} />
              </li>
            ))}
          </ul>
        )}

        <footer className="mt-auto pt-2 text-[11px] leading-relaxed text-muted">
          Building footprints and street centrelines are © OpenStreetMap
          contributors, licensed ODbL. Parcels, owners, tenure, utility
          alignments and every register attribute are derived or synthetic and
          are labelled as such throughout the viewer. Identifiers are an
          unofficial vertical extension of the 14-digit ULPIN (Bhu-Aadhaar) and
          carry no legal weight.
        </footer>
      </div>
    </main>
  );
}

function Empty() {
  return (
    <div className="glass rounded-lg p-4">
      <p className="panel-title">No projects</p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Nothing is registered yet. Seed the demo area of interest with{' '}
        <code className="font-mono text-ink">npm run seed</code>, or a new one
        with{' '}
        <code className="font-mono text-ink">
          npm run seed -- --slug=… --name=… --bbox=w,s,e,n --state=.. --district=…
        </code>
        .
      </p>
    </div>
  );
}
