'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The two-tab login form.
 *
 * One component, two flows:
 *   - Citizen: pick a project, enter aadhar + phone. POSTs to
 *     /api/auth/citizen/login.
 *   - Government: enter email + password. POSTs to
 *     /api/auth/gov/login.
 *
 * The response is a JSON shape, not a redirect: the server sets the
 * cookie via Set-Cookie and returns the role + identity, and the
 * client routes from there. The full server response is the source of
 * truth for "where do I go next" -- a citizen's project is in the
 * response, a government's is the demo project's.
 */
type Project = { slug: string; name: string };

export default function LoginForm({
  projects,
  defaultProject,
}: {
  projects: Project[];
  defaultProject: string;
}) {
  const router = useRouter();
  const [role, setRole] = useState<'citizen' | 'gov'>('citizen');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Form state. Kept in one object so the role switch resets both
  // halves without bookkeeping.
  const [citizen, setCitizen] = useState({
    slug: defaultProject,
    aadhar: '',
    phone: '',
  });
  const [gov, setGov] = useState({ email: '', password: '' });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const url = role === 'citizen'
        ? '/api/auth/citizen/login'
        : '/api/auth/gov/login';
      const body = role === 'citizen' ? citizen : gov;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text || `${res.status} ${res.statusText}`);
        return;
      }
      const data = await res.json() as { role: string; slug?: string };
      // Refresh: the project page reads the cookie on the server and
      // the data it ships depends on the role, so a router.refresh() is
      // what gets the new cookie into the next request.
      const target = data.role === 'citizen' && data.slug
        ? `/p/${data.slug}`
        : '/';
      router.push(target);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="glass space-y-4 rounded-lg p-5">
      <div className="flex gap-1 rounded border border-edge p-1 text-[11px]">
        <button
          type="button"
          onClick={() => setRole('citizen')}
          className={roleTabClass(role === 'citizen')}
        >
          Citizen
        </button>
        <button
          type="button"
          onClick={() => setRole('gov')}
          className={roleTabClass(role === 'gov')}
        >
          Government
        </button>
      </div>

      {role === 'citizen' ? (
        <div className="space-y-3">
          <Field label="Project">
            <select
              className={inputClass}
              value={citizen.slug}
              onChange={(e) => setCitizen((s) => ({ ...s, slug: e.target.value }))}
            >
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Aadhar (12 digits)">
            <input
              inputMode="numeric"
              pattern="\d{12}"
              maxLength={12}
              className={inputClass}
              value={citizen.aadhar}
              onChange={(e) => setCitizen((s) => ({ ...s, aadhar: e.target.value.replace(/\D/g, '') }))}
              placeholder="1111-2222-3333"
              required
            />
          </Field>
          <Field label="Phone (10 digits)">
            <input
              inputMode="numeric"
              pattern="\d{10}"
              maxLength={10}
              className={inputClass}
              value={citizen.phone}
              onChange={(e) => setCitizen((s) => ({ ...s, phone: e.target.value.replace(/\D/g, '') }))}
              placeholder="9876543210"
              required
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Email">
            <input
              type="email"
              className={inputClass}
              value={gov.email}
              onChange={(e) => setGov((s) => ({ ...s, email: e.target.value }))}
              placeholder="admin@sampath.gov.in"
              required
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              className={inputClass}
              value={gov.password}
              onChange={(e) => setGov((s) => ({ ...s, password: e.target.value }))}
              required
            />
          </Field>
        </div>
      )}

      {error ? (
        <p className="rounded border border-[rgb(var(--danger))] bg-[rgb(var(--danger))]/10 px-2 py-1 text-[11px] text-[rgb(var(--danger))]">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded border border-edge-strong bg-surface-2 px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass = 'w-full rounded border border-edge bg-bg px-2 py-1.5 text-[12px] text-ink focus:border-edge-strong focus:outline-none';

function roleTabClass(active: boolean): string {
  const base = 'flex-1 rounded px-2 py-1.5 transition';
  return active
    ? `${base} bg-surface-2 text-ink`
    : `${base} text-muted hover:text-ink`;
}
