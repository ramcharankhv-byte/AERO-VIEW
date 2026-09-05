import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth/guards';
import type { ReactNode } from 'react';

/**
 * Server-side gate for the project viewer.
 *
 * Three outcomes:
 *   - No session: redirect to /login (the slug is preserved so the
 *     citizen's project is the one shown after they sign in).
 *   - Government: render children, full AOI.
 *   - Citizen: render children, but only on the right project. A
 *     citizen trying to open a different project is bounced to their
 *     own -- the API would 404 their data anyway, so an early
 *     redirect is the kinder failure mode.
 *
 * Why this lives on the server, not in a useEffect on the client:
 * the project page already runs on the server, and shipping a
 * project page that the client then has to redirect away from is
 * a flash of unauthorised UI. Bouncing in the server render means
 * the URL changes before a single byte of Cesium is sent.
 */
export default async function RoleGate({
  slug,
  children,
}: {
  slug: string;
  children: ReactNode;
}) {
  const me = await currentSession();
  if (!me) {
    redirect(`/login?next=${encodeURIComponent(`/p/${slug}`)}`);
  }
  if (me.kind === 'citizen' && me.claims.slug !== slug) {
    redirect(`/p/${me.claims.slug}`);
  }
  return <>{children}</>;
}
