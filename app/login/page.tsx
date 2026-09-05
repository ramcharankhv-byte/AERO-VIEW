import { redirect } from 'next/navigation';
import { listProjects, DEFAULT_SLUG } from '@/lib/projects';
import { currentSession } from '@/lib/auth/guards';
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in — 3D ULPIN',
};

/**
 * The login page.
 *
 * If a session is already valid, the user is sent to their project
 * (citizen -> their building, gov -> the demo project). The form is
 * only rendered when no session is present.
 *
 * The list of projects the citizen can pick from is rendered from the
 * same registry the rest of the application reads, so adding a project
 * shows up in the dropdown without further changes.
 */
export default async function LoginPage() {
  const me = await currentSession();
  if (me) {
    if (me.kind === 'gov') {
      redirect('/');
    } else {
      redirect(`/p/${me.claims.slug}`);
    }
  }

  const projects = await listProjects();
  const defaultProject = projects[0]?.slug ?? DEFAULT_SLUG;

  return (
    <main className="grid min-h-dvh w-screen place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="panel-title">3D ULPIN — Sign in</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">
            Citizen or government?
          </h1>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            A citizen sees their own building, their floor, and the underground
            parking. A government official sees the full AOI as today, with the
            same controls.
          </p>
        </div>
        <LoginForm
          projects={projects.map((p) => ({ slug: p.slug, name: p.name }))}
          defaultProject={defaultProject}
        />
        <p className="mt-6 text-center text-[11px] leading-relaxed text-muted">
          Demo accounts:
          <br />
          <span className="font-mono text-ink">Aadhar 111122223333 / phone 9876543210</span>
          {' '}· Aadhar 222233334444 / phone 9876543211 · Aadhar 333344445555 / phone 9876543212
          <br />
          Government: <span className="font-mono text-ink">admin@sampath.gov.in</span> /
          {' '}<span className="font-mono text-ink">ulpin-gov-2026</span>
        </p>
      </div>
    </main>
  );
}
