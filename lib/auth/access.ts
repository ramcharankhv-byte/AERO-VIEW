import { NextResponse } from 'next/server';
import { currentSession } from './guards';
import {
  checkBuildingAccess, checkMutation, checkProjectAccess,
  filterDetailForCaller, isMutator, ownsUnit, type CallerContext,
} from './access-pure';

/**
 * Role-aware access for the cadastre endpoints, Next-coupled.
 *
 * This module wraps the pure checks in lib/auth/access-pure.ts and
 * turns their refusals into NextResponse objects. The pure module is
 * what the test suite imports; this one is what the route handlers
 * import. Splitting the two means the test does not pull in
 * `next/server` (which is a runtime-only module), and a future
 * framework change can swap the wrappers without touching the rules.
 *
 * The collection filter is the third form of restriction -- a
 * "filter" rather than a "refusal". It is implemented inside the
 * handler because the filter knows the GeoJSON shape of its
 * particular resource; only the rules about WHO can see WHAT are
 * centralised here.
 */

export type { CallerContext };

/** Read the caller's role from the session cookie. */
export async function callerContext(req: Request): Promise<CallerContext> {
  // currentSession() reads from next/headers, which is the runtime
  // source of the cookie. The req is kept for the future case where
  // the cookie is delivered in a non-standard way (e.g. an
  // integration test) -- it is not consulted today.
  void req;
  const me = await currentSession();
  if (!me) return { kind: 'anon' };
  if (me.kind === 'gov') return { kind: 'gov' };
  return {
    kind: 'citizen',
    slug: me.claims.slug,
    buildingId: me.claims.buildingId,
    floor: me.claims.floor,
    unit: me.claims.unit,
  };
}

/** True when this caller may write to the cadastre. */
export { isMutator, ownsUnit, filterDetailForCaller };

function toResponse(refusal: { status: number; body: unknown }): NextResponse {
  return NextResponse.json(refusal.body, { status: refusal.status });
}

/** For a building-scoped request, the citizen must own the building. */
export function enforceBuildingAccess(
  ctx: CallerContext,
  slug: string,
  buildingId: number,
): NextResponse | null {
  const r = checkBuildingAccess(ctx, slug, buildingId);
  return r ? toResponse(r) : null;
}

/** A 403 for mutating calls. */
export function refuseMutation(ctx: CallerContext): NextResponse | null {
  const r = checkMutation(ctx);
  return r ? toResponse(r) : null;
}

/** For a project-scoped call, the citizen must be on the right project. */
export function enforceProjectAccess(
  ctx: CallerContext,
  slug: string,
): NextResponse | null {
  const r = checkProjectAccess(ctx, slug);
  return r ? toResponse(r) : null;
}
