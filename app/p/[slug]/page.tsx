import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveProject, unavailableMessage } from '@/lib/projects';
import RoleGate from '@/components/auth/RoleGate';
import ProjectViewer from './ProjectViewer';

export const dynamic = 'force-dynamic';

/**
 * One project's viewer.
 *
 * Resolution happens on the server, before a single byte of Cesium is sent,
 * because the two failure modes are answered differently and neither is worth
 * booting a globe for:
 *
 *   unknown slug   -> 404, Next's not-found page
 *   known but unservable (no snapshot, database down)
 *                  -> a panel that says which of those it is and what to do
 *
 * The second is the reason this is not just `notFound()` for anything that
 * cannot be loaded: "your project does not exist" and "your database is not
 * running" are different problems, and only one of them is the user's data.
 */
export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const resolution = await resolveProject(slug);
  if (resolution.kind === 'not-found') return { title: 'Project not found — 3D ULPIN' };
  return {
    title: `${resolution.project.name} — 3D ULPIN`,
    description:
      `Three-dimensional cadastral viewer for ${resolution.project.name}: parcel, `
      + 'building, floor and unit volumes with underground utility conflicts.',
  };
}

export default async function Page(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const resolution = await resolveProject(slug);

  if (resolution.kind === 'not-found') notFound();

  if (resolution.kind === 'unavailable') {
    return <Unavailable message={unavailableMessage(resolution.project)}
      name={resolution.project.name} />;
  }

  return (
    <RoleGate slug={resolution.project.slug}>
      <ProjectViewer project={resolution.project} />
    </RoleGate>
  );
}

/**
 * A real project that nothing can currently answer for.
 *
 * Styled from the same panel classes the chrome uses -- see the note in
 * app/globals.css -- so it introduces no colour of its own.
 */
function Unavailable({ name, message }: { name: string; message: string }) {
  return (
    <main className="grid h-dvh w-screen place-items-center bg-bg px-4">
      <div className="glass max-w-lg rounded-lg p-5">
        <p className="panel-title">Project unavailable</p>
        <h1 className="mt-2 text-lg font-semibold text-ink">{name}</h1>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">{message}</p>
        <Link
          href="/"
          className="tint-hover mt-4 inline-block rounded border border-edge px-2 py-1 text-[11px] text-ink"
        >
          ← All projects
        </Link>
      </div>
    </main>
  );
}
