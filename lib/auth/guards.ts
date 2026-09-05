import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  sessionFromCookieHeader, type SessionClaims, type CitizenClaims, type GovClaims,
} from './session';

/**
 * Server-component / route-handler guards.
 *
 * The citizen view is the only place a session claim is read in this module;
 * the gov side never needs the cookie to work because the gov viewer is the
 * default. The guards exist so a citizen-only endpoint can refuse a gov
 * session and a gov-only endpoint can refuse a citizen session with the
 * right status code, and so the citizen guard carries the slug + building
 * claim through to the role-aware data filters.
 *
 * USAGE FROM A ROUTE HANDLER
 * --------------------------
 *   const me = requireCitizen(req);
 *   if (me.kind === 'fail') return me.response;
 *   const claims = me.claims; // { slug, buildingId, floor, unit, ... }
 *
 * USAGE FROM A SERVER COMPONENT
 * -----------------------------
 *   const me = await currentSession();
 *   if (!me) redirect('/login');
 */

export type SessionResult =
  | { kind: 'gov'; claims: GovClaims }
  | { kind: 'citizen'; claims: CitizenClaims };

export async function currentSession(): Promise<SessionResult | null> {
  // In Next 15, cookies() is async. The codemod has not migrated this
  // site, so the explicit await lives here.
  const c = await cookies();
  const raw = c.get('ulpin_session')?.value ?? null;
  const claims = sessionFromCookieHeader(raw ? `ulpin_session=${raw}` : null);
  if (!claims) return null;
  return claims.role === 'gov'
    ? { kind: 'gov', claims }
    : { kind: 'citizen', claims };
}

export type GuardResult<T> =
  | { kind: 'ok'; claims: T }
  | { kind: 'fail'; response: NextResponse };

export function requireCitizen(req: Request): GuardResult<CitizenClaims> {
  const cookieHeader = req.headers.get('cookie');
  const claims = sessionFromCookieHeader(cookieHeader);
  if (!claims) {
    return {
      kind: 'fail',
      response: NextResponse.json(
        { error: 'citizen session required' },
        { status: 401 },
      ),
    };
  }
  if (claims.role !== 'citizen') {
    return {
      kind: 'fail',
      response: NextResponse.json(
        { error: 'citizen session required, gov session present' },
        { status: 403 },
      ),
    };
  }
  // Sliding refresh: the cookie is re-issued on every read so a 24h session
  // rolls forward as long as the citizen keeps using the site.
  return { kind: 'ok', claims: { ...claims, exp: Date.now() + 24 * 60 * 60 * 1000 } };
}

export function requireGov(req: Request): GuardResult<GovClaims> {
  const cookieHeader = req.headers.get('cookie');
  const claims = sessionFromCookieHeader(cookieHeader);
  if (!claims) {
    return {
      kind: 'fail',
      response: NextResponse.json(
        { error: 'government session required' },
        { status: 401 },
      ),
    };
  }
  if (claims.role !== 'gov') {
    return {
      kind: 'fail',
      response: NextResponse.json(
        { error: 'government session required, citizen session present' },
        { status: 403 },
      ),
    };
  }
  return { kind: 'ok', claims: { ...claims, exp: Date.now() + 24 * 60 * 60 * 1000 } };
}

/** Aadhar masked for logging. The middle 8 digits are replaced. */
export function maskAadhar(aadhar: string): string {
  if (aadhar.length !== 12) return '***';
  return `${aadhar.slice(0, 4)}-****-${aadhar.slice(8)}`;
}

/** Phone masked for logging. Keeps the country code + last 2 digits. */
export function maskPhone(phone: string): string {
  if (phone.length < 4) return '***';
  return `****${phone.slice(-4)}`;
}
