import type { BuildingStatus } from '@/lib/types';

/**
 * The editable shape of a building, and the rules that govern it.
 *
 * ONE MODULE, TWO CALLERS. The PATCH handler and the edit form both import
 * this. That is the whole point: a rule written twice is a rule that will
 * disagree with itself, and the user would then meet a field that passes in
 * the browser and fails on the server with a different message. Because both
 * sides produce the same `FieldError` shape, a server-only rejection renders
 * in exactly the same per-field slot as a client-side one.
 *
 * Deliberately free of `fs`, React and 'use client' so it can be imported from
 * either environment.
 *
 * COORDINATES AND ULPIN ARE ABSENT BY CONSTRUCTION. They are not listed in
 * BuildingEdit, so `coerceEdit` rejects them with a named error rather than
 * silently ignoring them. That makes read-only a property of the type rather
 * than a check somebody has to remember to write.
 */

export interface BuildingEdit {
  name: string;
  building_type: string;
  floors: number;
  height_m: number;
  built_up_m2: number;
  occupancy_units: number;
  address: string;
  owner_org: string;
  status: BuildingStatus;
}

export const EDITABLE_FIELDS = [
  'name', 'building_type', 'floors', 'height_m',
  'built_up_m2', 'occupancy_units', 'address', 'owner_org', 'status',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const BUILDING_STATUSES: readonly BuildingStatus[] = [
  'Occupied', 'Partially occupied', 'Vacant',
  'Under construction', 'Under renovation',
];

export interface FieldError {
  field: EditableField;
  message: string;
}

const NUMERIC: ReadonlySet<EditableField> = new Set([
  'floors', 'height_m', 'built_up_m2', 'occupancy_units',
]);

/** Fields the user may not leave empty. */
const REQUIRED: ReadonlySet<EditableField> = new Set([
  'name', 'building_type', 'address', 'owner_org', 'status',
]);

export const FIELD_LABEL: Record<EditableField, string> = {
  name: 'Building name',
  building_type: 'Building type',
  floors: 'Floors',
  height_m: 'Height',
  built_up_m2: 'Built-up area',
  occupancy_units: 'Occupancy',
  address: 'Address',
  owner_org: 'Owner / organisation',
  status: 'Status',
};

const MAX_LEN: Partial<Record<EditableField, number>> = {
  name: 80, building_type: 60, address: 160, owner_org: 120,
};

/**
 * Whitelist and type-coerce an untrusted body.
 *
 * Unknown keys are an ERROR rather than being dropped: a client that PATCHes
 * `ulpin` or `lat` has misunderstood the contract, and telling it so is more
 * useful than accepting the request and silently discarding half of it.
 */
export function coerceEdit(
  raw: unknown,
): { ok: true; value: Partial<BuildingEdit> } | { ok: false; errors: FieldError[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: 'name', message: 'Body must be a JSON object.' }] };
  }
  const errors: FieldError[] = [];
  const out: Partial<BuildingEdit> = {};
  const allowed = new Set<string>(EDITABLE_FIELDS);

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      errors.push({
        field: 'name',
        message: `"${key}" is not editable`
          + (key === 'ulpin' || key === 'lat' || key === 'lon'
            ? ' — coordinates and ULPIN are read-only.'
            : '.'),
      });
      continue;
    }
    const field = key as EditableField;
    if (NUMERIC.has(field)) {
      // Accept a numeric string so a form input needs no pre-parsing, but
      // reject the empty string rather than letting Number('') become 0 --
      // "I cleared the box" must not silently mean "zero".
      if (value === '' || value === null || value === undefined) {
        errors.push({ field, message: `${FIELD_LABEL[field]} is required.` });
        continue;
      }
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        errors.push({ field, message: `${FIELD_LABEL[field]} must be a number.` });
        continue;
      }
      (out as Record<string, unknown>)[field] = n;
    } else {
      if (typeof value !== 'string') {
        errors.push({ field, message: `${FIELD_LABEL[field]} must be text.` });
        continue;
      }
      (out as Record<string, unknown>)[field] = value.trim();
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/**
 * Validate a coerced patch.
 *
 * `ctx` carries the values the patch does not itself contain, so a rule that
 * spans two fields (height against storey count) still works when only one of
 * them is being changed.
 */
export function validateEdit(
  patch: Partial<BuildingEdit>,
  ctx: { floors: number; height_m: number },
): FieldError[] {
  const errors: FieldError[] = [];

  for (const field of EDITABLE_FIELDS) {
    if (!(field in patch)) continue;
    const v = patch[field];

    if (REQUIRED.has(field) && (typeof v !== 'string' || v.length === 0)) {
      errors.push({ field, message: `${FIELD_LABEL[field]} cannot be empty.` });
      continue;
    }
    const max = MAX_LEN[field];
    if (max && typeof v === 'string' && v.length > max) {
      errors.push({ field, message: `${FIELD_LABEL[field]} must be ${max} characters or fewer.` });
    }
  }

  if (patch.floors !== undefined) {
    if (!Number.isInteger(patch.floors)) {
      errors.push({ field: 'floors', message: 'Floors must be a whole number.' });
    } else if (patch.floors < 0) {
      errors.push({ field: 'floors', message: 'Floors cannot be negative.' });
    } else if (patch.floors > 200) {
      errors.push({ field: 'floors', message: 'Floors must be 200 or fewer.' });
    }
  }
  if (patch.height_m !== undefined) {
    if (patch.height_m <= 0) {
      errors.push({ field: 'height_m', message: 'Height must be greater than zero.' });
    } else if (patch.height_m > 400) {
      errors.push({ field: 'height_m', message: 'Height must be 400 m or less.' });
    }
  }
  if (patch.built_up_m2 !== undefined) {
    if (patch.built_up_m2 <= 0) {
      errors.push({ field: 'built_up_m2', message: 'Built-up area must be greater than zero.' });
    } else if (patch.built_up_m2 > 500000) {
      errors.push({ field: 'built_up_m2', message: 'Built-up area must be 500,000 m² or less.' });
    }
  }
  if (patch.occupancy_units !== undefined) {
    if (!Number.isInteger(patch.occupancy_units)) {
      errors.push({ field: 'occupancy_units', message: 'Occupancy must be a whole number.' });
    } else if (patch.occupancy_units < 0) {
      errors.push({ field: 'occupancy_units', message: 'Occupancy cannot be negative.' });
    }
  }
  if (patch.status !== undefined
      && !BUILDING_STATUSES.includes(patch.status as BuildingStatus)) {
    errors.push({ field: 'status', message: 'Status is not one of the allowed values.' });
  }

  return errors;
}

/**
 * Non-blocking sanity warnings.
 *
 * A 3 m floor-to-floor is what the geometry pipeline assumes, so a value far
 * outside that range is usually a typo -- but it is not the viewer's place to
 * refuse a number a surveyor might genuinely have measured. Warned, not
 * rejected.
 */
export function warningsFor(
  patch: Partial<BuildingEdit>,
  ctx: { floors: number; height_m: number },
): string[] {
  const out: string[] = [];
  const floors = patch.floors ?? ctx.floors;
  const height = patch.height_m ?? ctx.height_m;
  if (floors > 0 && height > 0) {
    const perFloor = height / floors;
    if (perFloor < 2.2 || perFloor > 6) {
      out.push(
        `Floor-to-floor works out at ${perFloor.toFixed(1)} m. `
        + 'Typical is 2.8–3.5 m — check the storey count and height agree.',
      );
    }
  }
  return out;
}
