import { NextResponse } from 'next/server';
import { backend, getBuildingDetail } from '@/lib/db';
import { applyEdit } from '@/lib/data/edits';
import { coerceEdit, validateEdit, warningsFor } from '@/lib/data/building-schema';

export const dynamic = 'force-dynamic';

/** Shared id parsing, so GET and PATCH cannot disagree about what is valid. */
function parseId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) ? n : null;
}

/** GET /api/building/:id -> building with its floors and units nested. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const numeric = parseId(id);
  if (numeric === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  try {
    const detail = await getBuildingDetail(numeric);
    if (!detail) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
    }
    return NextResponse.json(detail, {
      headers: { 'x-ulpin-backend': await backend() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load building', detail: String(err) },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/building/:id -> record a manual edit and return the new document.
 *
 * The response body is the FULL re-read BuildingDetail rather than an
 * acknowledgement, so the client replaces its cached document with a
 * server-authoritative one in a single write and can never drift from what
 * the next reader would see.
 *
 * Status codes carry meaning the form relies on:
 *   400  the body was malformed, or named a field that is not editable
 *        (coordinates and ULPIN land here)
 *   404  no such building
 *   422  well-formed but invalid -- the per-field errors render in the form
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const numeric = parseId(id);
  if (numeric === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be valid JSON' }, { status: 400 });
  }

  const coerced = coerceEdit(body);
  if (!coerced.ok) {
    return NextResponse.json(
      { error: 'unrecognised or mistyped fields', errors: coerced.errors },
      { status: 400 },
    );
  }

  try {
    const current = await getBuildingDetail(numeric);
    if (!current) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
    }

    // Validated against the CURRENT values, so a rule spanning two fields
    // still holds when only one of them is in the patch.
    const ctxValues = {
      floors: current.building.floors,
      height_m: current.building.height_m,
    };
    const errors = validateEdit(coerced.value, ctxValues);
    if (errors.length) {
      return NextResponse.json({ error: 'validation failed', errors }, { status: 422 });
    }

    const record = await applyEdit(numeric, coerced.value);
    const updated = await getBuildingDetail(numeric);

    return NextResponse.json(
      {
        detail: updated,
        rev: record.rev,
        updated_at: record.updated_at,
        warnings: warningsFor(coerced.value, ctxValues),
      },
      {
        headers: {
          'x-ulpin-backend': await backend(),
          'x-ulpin-edit-rev': String(record.rev),
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to save building', detail: String(err) },
      { status: 500 },
    );
  }
}
