import { round2 } from './scoring.ts';

/**
 * Days between the epoch day and the day momentum is measured against.
 *
 * One week: a daily epoch makes day over day movement mostly noise, and a
 * month over month view is too slow to describe a spike that is already over.
 */
export const MOMENTUM_WINDOW_DAYS = 7;

/**
 * How attention is moving, as distinct from how much attention there is.
 *
 * The index answers "how loud is it relative to its own baseline". Momentum
 * answers "is it getting louder" by comparing the published index with the
 * index published `windowDays` earlier. The two disagree on purpose: a viral
 * subject with a low index can have high momentum, and a permanently loud
 * subject can sit at a high index with flat momentum.
 */
export interface Momentum {
  readonly windowDays: number;
  /** Epoch day the current score is compared against. */
  readonly referenceDay: string;
  /** Index points gained (positive) or lost (negative) over the window. */
  readonly delta: number;
  /** 0 to 100, where 50 is flat and one index point is one momentum point. */
  readonly score: number;
}

/**
 * Derives momentum from two published index scores.
 *
 * Returns null rather than a guess when either score is missing, because a
 * momentum value invented from a single observation would be indistinguishable
 * in the snapshot from a measured one.
 */
export function momentumFrom(
  currentScore: number | null,
  referenceScore: number | null,
  referenceDay: string,
): Momentum | null {
  if (currentScore === null || referenceScore === null) {
    return null;
  }
  const delta = round2(currentScore - referenceScore);
  return {
    windowDays: MOMENTUM_WINDOW_DAYS,
    referenceDay,
    delta,
    score: round2(Math.min(100, Math.max(0, 50 + delta))),
  };
}
