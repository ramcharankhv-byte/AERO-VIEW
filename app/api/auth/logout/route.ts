import { NextResponse } from 'next/server';
import {
  buildClearCookie,
  revokeSession,
  sessionFromCookieHeader,
} from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout
 *
 * Clears the session cookie. The stateless design has no real revocation,
 * so the in-memory _revoked set is also updated with the cookie's sid --
 * this is the belt-and-braces for the case where the cookie has been
 * captured by something other than the browser that just cleared it.
 *
 * GET on the same path is intentionally NOT implemented: logout is a
 * mutation, and a GET that mutates is the kind of thing a CSRF can
 * exploit. The shape is the one every other auth route uses.
 */
export async function POST(req: Request) {
  const claims = sessionFromCookieHeader(req.headers.get('cookie'));
  if (claims) {
    revokeSession(claims.sid);
  }
  return NextResponse.json(
    { ok: true },
    { headers: { 'set-cookie': buildClearCookie() } },
  );
}

/** Accepting GET as well would mean a third-party <img src="/api/auth/logout">
 *  could log the user out. The only legitimate caller is the explicit
 *  Sign Out button, which uses POST. */
export function GET() {
  return NextResponse.json(
    { error: 'use POST to log out' },
    { status: 405, headers: { allow: 'POST' } },
  );
}
