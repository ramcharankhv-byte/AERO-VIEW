import { NextResponse } from 'next/server';
import { currentSession, maskAadhar } from '@/lib/auth/guards';
import { buildSetCookie, isHttpsRequest } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * GET /api/me
 *
 * Returns the current session. A signed-out caller gets 200 with
 * `role: null`; the front end uses that to render /login rather than
 * treating the absence of a session as an error.
 *
 * A successful read also re-issues the session cookie, which is the
 * sliding refresh: a user who keeps the tab open stays logged in for
 * another 24h from the last interaction. The session claims live in
 * the cookie, so this handler does not touch the roster -- only login
 * does. A logout that removed the resident from residents.json is
 * visible on the next login attempt, not here.
 */
export async function GET(req: Request) {
  const me = await currentSession();
  if (!me) {
    return NextResponse.json({ role: null });
  }
  const secure = isHttpsRequest(req);
  if (me.kind === 'gov') {
    return NextResponse.json(
      {
        role: 'gov',
        name: me.claims.name,
        email: me.claims.sub,
      },
      { headers: { 'set-cookie': buildSetCookie(me.claims, { secure }) } },
    );
  }
  return NextResponse.json(
    {
      role: 'citizen',
      name: me.claims.name,
      slug: me.claims.slug,
      buildingId: me.claims.buildingId,
      floor: me.claims.floor,
      unit: me.claims.unit,
      aadharMasked: maskAadhar(me.claims.sub),
    },
    { headers: { 'set-cookie': buildSetCookie(me.claims, { secure }) } },
  );
}
