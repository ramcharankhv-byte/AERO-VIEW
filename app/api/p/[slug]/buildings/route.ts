import { buildingsRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/buildings
 *
 * The body lives in lib/api/handlers.ts, shared with the unscoped alias at
 * /api/buildings so the two can never answer differently.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return buildingsRoute(slug, req);
}
