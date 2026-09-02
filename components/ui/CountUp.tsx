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
  const skip = played || prefersReducedMotion();
  const [shown, setShown] = useState(skip ? value : 0);

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

  // tabular-nums keeps the glyph width fixed, so the row does not twitch as the
  // digits change.
  return <span className="tabular-nums">{shown.toLocaleString()}</span>;
}
