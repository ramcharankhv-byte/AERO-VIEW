/**
 * Pure-logic role checks. NO `next/server` or `next/headers` imports, so
 * this module is testable from a plain Node script. The response
 * builders in lib/auth/access.ts wrap these and return a NextResponse
 * on refusal.
 *
 * The "no Next imports here" rule is the reason every helper in this
 * file returns either null (pass) or a plain object describing the
 * refusal (status + body), instead of a NextResponse. The route
 * handler takes the refusal object and turns it into a NextResponse;
 * the test suite just inspects the status and the error string.
 *
 * callerContext() lives in lib/auth/access.ts because it reads the
 * session from the Next-managed cookie jar, which is a runtime
 * concern, not a rules concern.
 */

export type CallerContext =
  | { kind: 'gov' }
  | { kind: 'citizen'; slug: string; buildingId: number }
  | { kind: 'anon' };

export type AccessRefusal = { status: number; body: { error: string } };

/** True when this caller may write to the cadastre. Only gov may. */
export function isMutator(ctx: CallerContext): boolean {
  return ctx.kind === 'gov';
}

/**
 * For a building-scoped request, the citizen must own the building.
 * Returns a refusal on a denial, null on a pass.
 */
export function checkBuildingAccess(
  ctx: CallerContext,
  slug: string,
  buildingId: number,
): AccessRefusal | null {
  if (ctx.kind !== 'citizen') return null;
  if (ctx.slug !== slug || ctx.buildingId !== buildingId) {
    // 404 not 403, deliberately: a 403 would let an attacker enumerate
    // which ids exist by status code. 404 is the same shape a missing
    // building would have.
    return { status: 404, body: { error: 'building not found' } };
  }
  return null;
}

/** A refusal for mutating calls. */
export function checkMutation(ctx: CallerContext): AccessRefusal | null {
  if (ctx.kind === 'citizen') {
    return { status: 403, body: { error: 'government role required to edit' } };
  }
  if (ctx.kind === 'anon') {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  return null;
}

/** For a project-scoped call, the citizen must be on the right project. */
export function checkProjectAccess(
  ctx: CallerContext,
  slug: string,
): AccessRefusal | null {
  if (ctx.kind !== 'citizen') return null;
  if (ctx.slug !== slug) {
    return { status: 404, body: { error: 'project not found' } };
  }
  return null;
}
