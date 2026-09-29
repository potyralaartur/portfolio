/**
 * A stroke's speed profile: progress 0..1 -> share of its length. Shared by
 * the intro (where the nozzle is) and the build script (when paint lands at
 * each drip), so the two always agree. No extensionless imports: Node loads
 * this file as is.
 */
import { gsap } from 'gsap';

/**
 * Progress -> arc length for a stroke with turns (paths.json, found by the
 * build script): a Hermite curve through (0, 0), each turn at (s / L, s / L)
 * and (1, 1), still at both ends and at the turn's speed (x the stroke's
 * average) at each turn. The hand eases into turns without stopping.
 */
function turnEase(turns: { at: number; speed: number }[]) {
  const knots = [
    { p: 0, s: 0, m: 0 },
    ...turns.map((t) => ({ p: t.at, s: t.at, m: t.speed })),
    { p: 1, s: 1, m: 0 },
  ];
  return (p: number) => {
    let i = 0;
    while (i < knots.length - 2 && p > knots[i + 1].p) i++;
    const a = knots[i];
    const b = knots[i + 1];
    const h = b.p - a.p;
    const u = Math.min(Math.max((p - a.p) / h, 0), 1);
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * a.s + (u3 - 2 * u2 + u) * h * a.m + (-2 * u3 + 3 * u2) * b.s + (u3 - u2) * h * b.m;
  };
}

/** A stroke slows through its turns; otherwise it has its own ease (the schedule slot's) or the schedule's */
export function strokeEase(
  stroke: { length: number; turns?: { s: number; speed: number }[] },
  slotEase: string | undefined,
  scheduleEase: string,
): (p: number) => number {
  if (stroke.turns) return turnEase(stroke.turns.map((t) => ({ at: t.s / stroke.length, speed: t.speed })));
  return gsap.parseEase(slotEase ?? scheduleEase);
}
