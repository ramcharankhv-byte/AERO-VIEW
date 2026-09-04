import { conflictsRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/conflicts
 *
 * The body lives in lib/api/handlers.ts, shared with the unscoped alias at
 * /api/conflicts so the two can never answer differently.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return conflictsRoute(slug, req);
}
