import { queryRoute } from '@/lib/api/handlers';
import { DEFAULT_SLUG } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * POST /api/query -> the demo project.
 *
 * A thin alias onto /api/p/siripuram/query. The README documents this URL and
 * the acceptance scripts drive it; the handler body is shared with the scoped
 * route, so the two are byte-identical.
 */
export async function POST(req: Request) {
  return queryRoute(DEFAULT_SLUG, req);
}
