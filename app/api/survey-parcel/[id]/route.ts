import { surveyParcelDetailRoute } from '@/lib/api/handlers';
import { DEFAULT_SLUG } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/survey-parcel/:id -> the demo project.
 *
 * A thin alias onto /api/p/siripuram/survey-parcel/:id, following the same
 * convention as every other unscoped route: the handler body is shared, so
 * alias and scoped route are byte-identical.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return surveyParcelDetailRoute(DEFAULT_SLUG, id, req);
}
