import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { readGovRoster } from '@/lib/auth/lookup';
import { buildSetCookie, isHttpsRequest, makeGovSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/gov/login
 *   body: { email: string, password: string }
 *
 * Looks the email up in data/gov_users.json. The roster maps email to a
 * bcrypt hash; the plaintext is never on disk. The bcrypt.compare is
 * constant-time on the hash side and is the only expensive thing this
 * handler does.
 *
 * The 401 on a bad email deliberately takes the same shape as a bad
 * password. The bcrypt.compare on a missing email is short-circuited to
 * compare against a dummy hash so the response time is also uniform --
 * the difference between "no such user" and "wrong password" is a real
 * signal otherwise.
 *
 * The session cookie is the same one citizens get, just with role=gov.
 * A single cookie name means the server's sessionFromCookieHeader()
 * never has to ask which login flow the request came from.
 */

const Body = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const DUMMY_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8D1s8e1Y6Cw8Y1H0HkS0pYbF8Y3M1W';

export async function POST(req: Request) {
  let payload: z.infer<typeof Body>;
  try {
    const json = await req.json();
    const parsed = Body.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid request', detail: parsed.error.flatten() },
        { status: 400 },
      );
    }
    payload = parsed.data;
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const roster = await readGovRoster();
  const hash = roster[payload.email.toLowerCase()] ?? DUMMY_HASH;
  const ok = await bcrypt.compare(payload.password, hash);
  if (!ok || !roster[payload.email.toLowerCase()]) {
    return NextResponse.json(
      { error: 'email or password did not match' },
      { status: 401 },
    );
  }

  const claims = makeGovSession({
    email: payload.email.toLowerCase(),
    name: payload.email.split('@')[0] ?? payload.email,
  });

  const setCookie = buildSetCookie(claims, { secure: isHttpsRequest(req) });
  return NextResponse.json(
    {
      ok: true,
      role: 'gov',
      name: claims.name,
      email: claims.sub,
    },
    { headers: { 'set-cookie': setCookie } },
  );
}
