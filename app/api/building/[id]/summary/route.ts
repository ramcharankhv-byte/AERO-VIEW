import { buildingSummaryRoute } from '@/lib/api/handlers';
import { DEFAULT_SLUG } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/building/:id/summary -> the demo project.
 *
 * A thin alias onto /api/p/siripuram/building/:id/summary, following the same
 * convention as every other unscoped route on this branch: the handler body is
 * shared, so alias and scoped route are byte-identical.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return buildingSummaryRoute(DEFAULT_SLUG, id, req);
}
