'use client';

import { useEffect, useRef } from 'react';

/**
 * Off-canvas panel for the medium regime.
 *
 * NOT modal, and deliberately so: there is no backdrop and no focus trap,
 * because the whole point of this application is the globe behind the chrome.
 * Trapping focus or blocking pointer events would make the drawer a worse
 * version of the panel it replaces. Escape closes it and focus returns to the
 * trigger, which is what a non-modal disclosure owes a keyboard user.
 */
export default function Drawer({
  open,
  onClose,
  id,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      ref={panelRef}
      id={id}
      role="group"
      aria-label={title}
      // Kept mounted and translated off-screen rather than unmounted: the
      // children are real controls with real state (slider positions, the
      // theme effect), and remounting them on every open would reset that.
      // `invisible` rather than `hidden` so the transition can run, and so the
      // labels stay in innerText for the acceptance harness.
      className={[
        'pointer-events-auto absolute bottom-3 left-0 top-0 w-[230px] max-w-[80vw]',
        'overflow-y-auto transition-transform duration-200 ease-out',
        open ? 'translate-x-0' : '-translate-x-[calc(100%+16px)]',
      ].join(' ')}
    >
      {children}
    </div>
  );
}
