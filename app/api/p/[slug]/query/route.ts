import { queryRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/p/:slug/query {lon, lat, z}
 *
 * Every entity in this project whose 3D volume contains the point, ordered
 * parcel < building < floor < unit. The body lives in lib/api/handlers.ts,
 * shared with the unscoped alias at /api/query.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return queryRoute(slug, req);
}
