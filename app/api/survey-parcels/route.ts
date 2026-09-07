import { surveyParcelsRoute } from '@/lib/api/handlers';
import { DEFAULT_SLUG } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/survey-parcels -> the demo project.
 *
 * A thin alias onto /api/p/siripuram/survey-parcels, following the same
 * convention as every other unscoped route: the handler body is shared, so
 * alias and scoped route are byte-identical.
 */
export async function GET(req: Request) {
  return surveyParcelsRoute(DEFAULT_SLUG, req);
}
