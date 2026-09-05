'use client';

import { useEffect, useState } from 'react';
import LogoutButton from './LogoutButton';

/**
 * The current session, displayed in the top bar.
 *
 * Fetches /api/me on mount. The page's RoleGate guarantees a session
 * exists by the time the chrome renders, so the "no session" branch
 * is the post-logout flash before the next render: a null role and a
 * short "Sign in" link.
 *
 * The /api/me response carries `name` and either `unit` (citizen) or
 * `email` (gov). The chip uses the unit / floor for citizens because
 * that is the most useful piece of identity on screen -- the user
 * already knows their own name; what they want to confirm is "this is
 * the right flat".
 */
type Me =
  | { role: null }
  | { role: 'gov'; name: string; email: string }
  | { role: 'citizen'; name: string; slug: string; buildingId: number; floor: number; unit: string; aadharMasked: string };

export default function SessionChip() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { credentials: 'same-origin' })
      .then((r) => r.json() as Promise<Me>)
      .then((d) => { if (!cancelled) setMe(d); })
      .catch(() => { if (!cancelled) setMe({ role: null }); });
    return () => { cancelled = true; };
  }, []);

  if (!me) {
    return <span className="text-[10px] text-muted">…</span>;
  }
  if (me.role === null) {
    return (
      <a
        href="/login"
        className="rounded px-2 py-1 text-[11px] text-ink tint-hover"
      >
        Sign in
      </a>
    );
  }
  if (me.role === 'gov') {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden text-[10px] text-muted sm:inline">
          {me.email}
        </span>
        <LogoutButton className="rounded border border-edge px-2 py-1 text-[11px] text-ink tint-hover" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-[10px] text-muted sm:inline">
        {me.name} · {me.unit} · F{me.floor} · {me.aadharMasked}
      </span>
      <LogoutButton className="rounded border border-edge px-2 py-1 text-[11px] text-ink tint-hover" />
    </div>
  );
}
