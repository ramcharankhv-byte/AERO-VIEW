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
  // `floor` and `unit` come straight off the session claims and are what
  // narrows a citizen from "their building" to "their flat".
  | { kind: 'citizen'; slug: string; buildingId: number; floor: number; unit: string }
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

/** The subset of a unit this module needs in order to decide who owns it. */
interface UnitLike {
  unit_no: string;
  level_no: number;
}

/**
 * Is this the citizen's own flat?
 *
 * Matched on (level, unit code) because that is what the session carries --
 * the numeric unit id is assigned by the exporter and is not stable across a
 * re-seed, so a claim built on it would silently stop matching the day the
 * snapshot is regenerated. The code is the thing written on the door.
 */
export function ownsUnit(ctx: CallerContext, unit: UnitLike): boolean {
  if (ctx.kind !== 'citizen') return true;
  return unit.level_no === ctx.floor && unit.unit_no === ctx.unit;
}

/**
 * The geometry and placement every unit keeps, whoever is asking. None of it
 * says anything about who lives there.
 */
const PUBLIC_UNIT_FIELDS = [
  'id', 'floor_id', 'unit_no', 'level_no', 'z_min', 'z_max', 'ring',
] as const;

/**
 * Narrow a building detail document to what the caller may see.
 *
 * Gov and anon get it verbatim. A citizen gets their building, all of its
 * floors, and the SHAPE of every flat -- but the register behind a
 * neighbour's door is redacted: no ULPIN, no owner, no address, no areas, no
 * tenure or encumbrance. They keep `unit_no`, because a door number is
 * written on the door and the floor would be unreadable without it.
 *
 * Shown-but-redacted rather than removed, because a citizen is meant to be
 * able to look at their building and their floor. Deleting the neighbours
 * left them standing in an empty plate, which is a less honest picture of
 * where they live than four flats of which one is theirs.
 *
 * Done here, on the server, and not in the viewer: anyone can read a
 * response in devtools, so a filter that runs in the browser is decoration.
 */
export function filterDetailForCaller<
  T extends { units?: UnitLike[] },
>(ctx: CallerContext, detail: T): T {
  if (ctx.kind !== 'citizen') return detail;
  const units = Array.isArray(detail.units) ? detail.units : [];
  return {
    ...detail,
    units: units.map((u) => {
      if (ownsUnit(ctx, u)) return u;
      const source = u as unknown as Record<string, unknown>;
      const redacted: Record<string, unknown> = { restricted: true };
      for (const k of PUBLIC_UNIT_FIELDS) {
        if (k in source) redacted[k] = source[k];
      }
      return redacted as unknown as UnitLike;
    }),
  };
}
