'use client';

import { useEffect, useMemo } from 'react';
import { useDataStore, useEditStore } from '@/lib/store';
import {
  BUILDING_STATUSES, EDITABLE_FIELDS, FIELD_LABEL, validateEdit, warningsFor,
  type BuildingEdit, type EditableField, type FieldError,
} from '@/lib/data/building-schema';
import type { BuildingDetail, EnrichedBuilding } from '@/lib/types';

/**
 * Manual edit of a building's register attributes.
 *
 * Pessimistic, deliberately: Save disables the form, waits for the server, and
 * only closes on success. An optimistic update would show the user a value the
 * server may be about to reject, and this is a register — being briefly wrong
 * about a record is worse than being briefly slow.
 *
 * Validation is imported, not written here. lib/data/building-schema.ts is the
 * same module the PATCH handler uses, so a rule can never pass in the browser
 * and fail on the server; and because both sides emit the same FieldError
 * shape, a server-only rejection renders in exactly the same slot as a local
 * one.
 *
 * COORDINATES AND ULPIN ARE NOT HERE. Not disabled inputs — absent from the
 * form entirely, because they are absent from `BuildingEdit`. The panel shows
 * them as static rows. Read-only is a property of the type rather than of a
 * `disabled` attribute somebody could remove.
 */

/** One labelled control, laid out on the same grid as a read-only Row. */
function Field({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: EditableField;
  value: string | number;
  error?: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const numeric = field === 'floors' || field === 'height_m'
    || field === 'built_up_m2' || field === 'occupancy_units';
  const id = `edit-${field}`;
  return (
    <div className="py-[3px]">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="row-label shrink-0">
          {FIELD_LABEL[field]}
        </label>
        <div className="min-w-0 flex-1 pl-6">
          {field === 'status' ? (
            <select
              id={id}
              className="field"
              value={String(value)}
              disabled={disabled}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? `${id}-err` : undefined}
              onChange={(e) => onChange(e.target.value)}
            >
              {BUILDING_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          ) : (
            <input
              id={id}
              className="field text-right"
              // `inputMode` rather than type=number: a number input renders
              // spinner buttons whose innerText is a bare digit, and the
              // acceptance harness finds floor-ladder rungs by matching any
              // button whose text is 1-2 digits. It would click these instead.
              inputMode={numeric ? 'decimal' : undefined}
              value={String(value)}
              disabled={disabled}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? `${id}-err` : undefined}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      </div>
      {error ? (
        <p id={`${id}-err`} role="alert" className="pt-0.5 text-right text-[10px] text-dangerInk">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function BuildingEditForm({ building }: { building: EnrichedBuilding }) {
  const id = building.id;
  const drafts = useEditStore((s) => s.drafts);
  const saving = useEditStore((s) => s.saving);
  const fieldErrors = useEditStore((s) => s.fieldErrors);
  const formError = useEditStore((s) => s.formError);
  const setDraftField = useEditStore((s) => s.setDraftField);
  const cancelEdit = useEditStore((s) => s.cancelEdit);
  const setSaving = useEditStore((s) => s.setSaving);
  const setFieldErrors = useEditStore((s) => s.setFieldErrors);
  const setFormError = useEditStore((s) => s.setFormError);
  const finishSave = useEditStore((s) => s.finishSave);

  const putDetail = useDataStore((s) => s.putDetail);
  const patchBuilding = useDataStore((s) => s.patchBuilding);

  const draft = drafts[id] ?? {};
  const dirty = Object.keys(draft).length > 0;

  /** Current value of a field: the draft if touched, else the saved record. */
  const valueOf = (field: EditableField): string | number => {
    if (field in draft) return draft[field] as string | number;
    const v = (building as unknown as Record<string, unknown>)[field];
    return v === null || v === undefined ? '' : (v as string | number);
  };

  const errorFor = (field: EditableField) =>
    fieldErrors.find((e) => e.field === field)?.message;

  // Warn about a floor-to-floor that does not add up, without blocking it.
  const warnings = useMemo(() => {
    const floors = Number(valueOf('floors'));
    const height = Number(valueOf('height_m'));
    if (!Number.isFinite(floors) || !Number.isFinite(height)) return [];
    return warningsFor(
      { floors, height_m: height },
      { floors: building.floors, height_m: building.height_m },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, building.floors, building.height_m]);

  // A browser-level guard for the one navigation React cannot intercept.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const save = async () => {
    // Coerce the draft the way the server will, so the local check and the
    // remote one are looking at the same values.
    const patch: Partial<BuildingEdit> = {};
    for (const f of EDITABLE_FIELDS) {
      if (!(f in draft)) continue;
      const raw = draft[f];
      if (f === 'floors' || f === 'height_m' || f === 'built_up_m2' || f === 'occupancy_units') {
        (patch as Record<string, unknown>)[f] = raw === '' ? NaN : Number(raw);
      } else {
        (patch as Record<string, unknown>)[f] = String(raw).trim();
      }
    }

    const local: FieldError[] = validateEdit(patch, {
      floors: building.floors,
      height_m: building.height_m,
    });
    // Catch the one thing validateEdit cannot: a non-numeric string typed into
    // a numeric field arrives here as NaN.
    for (const f of ['floors', 'height_m', 'built_up_m2', 'occupancy_units'] as const) {
      if (f in patch && !Number.isFinite(patch[f] as number)
          && !local.some((e) => e.field === f)) {
        local.push({ field: f, message: `${FIELD_LABEL[f]} must be a number.` });
      }
    }
    if (local.length) { setFieldErrors(local); return; }

    setSaving(true);
    try {
      const res = await fetch(`/api/building/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.status === 400 || res.status === 422) {
        const body = await res.json();
        setFieldErrors(Array.isArray(body.errors) && body.errors.length
          ? body.errors
          : [{ field: 'name', message: body.error ?? 'The server rejected this change.' }]);
        return;
      }
      if (!res.ok) {
        setFormError(`Save failed (${res.status}). Your changes have been kept.`);
        return;
      }
      const body = await res.json() as {
        detail: BuildingDetail; rev: number;
      };
      // The response IS the new document, so the cache is REPLACED rather than
      // invalidated -- there is never a window where the panel has no detail.
      putDetail(id, body.detail);
      patchBuilding(id, body.detail.building);
      finishSave(id, body.rev);
    } catch {
      setFormError('Could not reach the server. Your changes have been kept.');
    }
  };

  return (
    <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
      <div className="panel-title">Edit building record</div>

      <div className="mt-1">
        {EDITABLE_FIELDS.map((f) => (
          <Field
            key={f}
            field={f}
            value={valueOf(f)}
            error={errorFor(f)}
            disabled={saving}
            onChange={(v) => setDraftField(id, f, v)}
          />
        ))}
      </div>

      {/* Read-only, and shown INSIDE the form rather than hidden while editing:
          the user needs to see that these exist and that they are not up for
          change, or the omission looks like an oversight. */}
      <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
        <div className="flex items-baseline justify-between gap-3 py-[3px]">
          <span className="row-label shrink-0">ULPIN</span>
          <span className="field field-readonly w-auto text-right font-mono text-[11px]">
            {building.ulpin}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-[3px]">
          <span className="row-label shrink-0">Coordinates</span>
          <span className="field field-readonly w-auto text-right font-mono text-[11px]">
            {building.lat?.toFixed(5)}, {building.lon?.toFixed(5)}
          </span>
        </div>
        <p className="pt-1 text-[9px] leading-snug text-[rgb(var(--muted-2))]">
          ULPIN and coordinates identify the building and cannot be edited here.
        </p>
      </div>

      {warnings.map((w) => (
        <p key={w} className="mt-2 text-[10px] leading-snug text-[rgb(var(--ink))]">
          ⚠ {w}
        </p>
      ))}

      {formError ? (
        <p role="alert" className="mt-2 rounded border border-danger/50 bg-danger/10 p-2 text-[11px] text-dangerInk">
          {formError}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className={[
            'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
            saving || !dirty ? 'is-disabled bg-[rgb(var(--surface-2))] text-[rgb(var(--muted))]' : 'is-active',
          ].join(' ')}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={() => cancelEdit(id)}
          disabled={saving}
          className="rounded px-2.5 py-1 text-[11px] text-[rgb(var(--ink))] tint-hover"
        >
          Cancel
        </button>
        {dirty && !saving ? (
          <span className="ml-auto text-[10px] text-[rgb(var(--muted))]">
            {Object.keys(draft).length} unsaved
          </span>
        ) : null}
      </div>
    </div>
  );
}
