'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sign Out.
 *
 * POSTs to /api/auth/logout, then refreshes. The server clears the
 * cookie and revokes the session id, so a back-button to the project
 * page finds the gate's "no session" branch and redirects to /login.
 *
 * A bare <button> rather than a custom control: the chrome already
 * styles it, and there is nothing about signing out that warrants
 * bespoke presentation. A pending state is the one bit of UI this
 * component owns -- the click should not be re-fireable while the
 * network call is in flight.
 */
export default function LogoutButton({ className = '' }: { className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          setError(`sign-out failed: ${res.status}`);
          return;
        }
        router.push('/login');
        router.refresh();
      } catch (e) {
        setError(String(e));
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={className}
        aria-label="Sign out"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      {error ? (
        <p className="mt-1 text-[10px] text-[rgb(var(--danger))]">{error}</p>
      ) : null}
    </>
  );
}
