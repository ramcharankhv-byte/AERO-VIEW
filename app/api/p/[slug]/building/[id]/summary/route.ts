import { buildingSummaryRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/building/:id/summary -> the building without its
 * floors and units.
 *
 * The first request a panel should make. For a tower the floors and units
 * are most of the document, and none of it is on screen until the user
 * opens the ladder or the unit grid.
 *
 * The body lives in lib/api/handlers.ts, shared with the unscoped alias so the
 * two can never answer differently.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  return buildingSummaryRoute(slug, id, req);
}
