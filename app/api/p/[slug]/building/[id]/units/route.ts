import { buildingUnitsRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/building/:id/units?level=&limit=&offset=
 *
 * The isolated-floor view wants one storey; an export wants pages. The page
 * size is capped on the server.
 *
 * The body lives in lib/api/handlers.ts, shared with the unscoped alias so the
 * two can never answer differently.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  return buildingUnitsRoute(slug, id, req);
}
