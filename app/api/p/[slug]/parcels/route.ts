import { parcelsRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/parcels
 *
 * The body lives in lib/api/handlers.ts, shared with the unscoped alias at
 * /api/parcels so the two can never answer differently.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return parcelsRoute(slug);
}
