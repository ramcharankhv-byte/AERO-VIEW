import { buildingDetailRoute, buildingPatchRoute } from '@/lib/api/handlers';
import { DEFAULT_SLUG } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET / PATCH /api/building/:id -> the demo project.
 *
 * Thin aliases onto /api/p/siripuram/building/:id. scripts/check_edit.mjs
 * drives this unscoped form end to end, so its every guarantee -- 400 for
 * coordinates and ULPIN, 422 for validation, the pessimistic save, the
 * full re-read in the response -- has to hold here identically. It does,
 * because it is the same function.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return buildingDetailRoute(DEFAULT_SLUG, id, req);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return buildingPatchRoute(DEFAULT_SLUG, id, req);
}
