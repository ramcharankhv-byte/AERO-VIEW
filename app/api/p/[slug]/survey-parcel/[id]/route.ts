import { surveyParcelDetailRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/p/:slug/survey-parcel/:id -> one parcel and the ULPIN tree beneath
 * it: parcel -> buildings -> floors -> units.
 *
 * The buildings are read through the same cached documents /building/:id
 * serves; nothing here re-queries for floors or units.
 *
 * The body lives in lib/api/handlers.ts, shared with the unscoped alias so the
 * two can never answer differently.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  return surveyParcelDetailRoute(slug, id, req);
}
