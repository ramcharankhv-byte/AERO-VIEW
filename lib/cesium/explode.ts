/**
 * Explode animation maths.
 *
 * The slider is 0-100; each floor lifts by its index * LIFT_PER_FLOOR metres,
 * eased so the stack opens fast and settles slowly rather than sliding linearly.
 */

export const LIFT_PER_FLOOR = 3.4;

/** Cubic ease-out: fast opening, gentle settle. */
export function cubicEase(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

/**
 * Vertical offset for a floor at `index` (0 = lowest rendered level).
 * `t` is the raw 0-100 slider value.
 */
export function liftFor(index: number, t: number): number {
  if (t <= 0) return 0;
  return index * LIFT_PER_FLOOR * cubicEase(t / 100);
}
