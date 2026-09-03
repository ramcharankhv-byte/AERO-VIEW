import { buildingDetailRoute, buildingPatchRoute } from '@/lib/api/handlers';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/p/:slug/building/:id  -> building with its floors and units nested
 * PATCH /api/p/:slug/building/:id -> record a manual edit, return the new doc
 *
 * Both bodies live in lib/api/handlers.ts, shared with the unscoped aliases at
 * /api/building/:id. Edits are stored per project, because building ids are
 * only unique within one.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  return buildingDetailRoute(slug, id);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  return buildingPatchRoute(slug, id, req);
}
