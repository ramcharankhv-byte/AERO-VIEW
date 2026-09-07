import { surveyParcelsRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/survey-parcels -> the 2D cadastral layer, as GeoJSON.
 *
 * Every feature carries its own `provenance`, so a caller can tell a derived
 * parcel from a surveyed one from the response alone rather than from which
 * endpoint answered.
 *
 * The body lives in lib/api/handlers.ts, shared with the unscoped alias so the
 * two can never answer differently.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return surveyParcelsRoute(slug, req);
}
