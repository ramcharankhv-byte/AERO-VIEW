'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A number that counts up from zero on the first load, then never again.
 *
 * One rAF loop drives every mounted instance: the AOI card animates three
 * figures at once, and three independent loops would be three sources of truth
 * for "how far through the animation are we".
 */

const DURATION_MS = 900;

type Tick = (eased: number) => void;

const subscribers = new Set<Tick>();
let raf = 0;
let startedAt = 0;
/**
 * The animation is a first-impression flourish, not a state indicator. Once it
 * has run, re-entering city view shows the figures immediately rather than
 * replaying a count-up over numbers the user has already read.
 */
let played = false;

/** Motion is decoration here, so honouring the OS setting costs nothing. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function frame(now: number) {
  if (startedAt === 0) startedAt = now;
  const t = Math.min(1, (now - startedAt) / DURATION_MS);
  const eased = easeOutCubic(t);
  for (const notify of subscribers) notify(eased);
  if (t < 1) {
    raf = requestAnimationFrame(frame);
    return;
  }
  raf = 0;
  startedAt = 0;
  played = true;
  subscribers.clear();
}

function subscribe(notify: Tick): () => void {
  subscribers.add(notify);
  if (raf === 0) raf = requestAnimationFrame(frame);
  return () => {
    subscribers.delete(notify);
  };
}

export default function CountUp({ value }: { value: number }) {
  // ALWAYS start at 0 on the very first render -- both on the server and on
  // the client's hydration pass. The first paint shows 0; the effect below
  // then either jumps to the target (reduced-motion / replayed) or starts
  // the count-up loop. This is the only state shape that guarantees the
  // server-rendered text and the client-rendered text agree on hydration.
  // The previous shape branched on `prefersReducedMotion()` during render,
  // which on a user with the OS reduced-motion setting turned ON would
  // cause the server to render 0 and the client to render `value` -- a
  // hydration mismatch on the visible text.
  const [shown, setShown] = useState(0);

  // Read through a ref so a value that settles mid-flight retargets the same
  // run rather than restarting it.
  const target = useRef(value);
  target.current = value;

  useEffect(() => {
    if (played || prefersReducedMotion()) {
      setShown(target.current);
      return;
    }
    return subscribe((eased) => setShown(Math.round(target.current * eased)));
  }, []);

  // `toLocaleString()` is locale-dependent and would diverge between server
  // (Node's default locale) and client (the user's browser locale), causing
  // a hydration mismatch on the digit grouping. Force a stable format that
  // uses commas regardless of where the code runs; the count-up animation
  // reads back through the same formatter.
  return <span className="tabular-nums">{shown.toLocaleString('en-US')}</span>;
}
