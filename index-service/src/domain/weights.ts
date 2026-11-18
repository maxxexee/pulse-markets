/**
 * Weighting for the headline index.
 *
 * Constituents carry published weights rather than equal shares, so the index
 * tracks a share of the attention pool instead of the mean of whoever happens
 * to be in the basket. Volume at the base period sets the weight, capped: over
 * 30 days of pageviews one constituent held 40 percent of the basket and the
 * smallest held 0.4, so an uncapped index would be that one page plus six
 * rounding errors.
 */

/** Published weights carry six decimals, so rounding never breaks the sum. */
const WEIGHT_DECIMALS = 6;
const WEIGHT_SCALE = 10 ** WEIGHT_DECIMALS;
/** Slack when deciding whether a share has hit the cap. */
const CAP_EPSILON = 1e-9;

/** One constituent score and the weight the definition gives it. */
export interface WeightedScore {
  readonly weight: number;
  /** Index points, or null when the constituent could not be scored. */
  readonly score: number | null;
}

export interface WeightedAggregate {
  /** Weighted mean over the scored constituents, null when none scored. */
  readonly score: number | null;
  /** Share of the intended weight that scored, 0 to 1. */
  readonly weightScored: number;
}

function assertNonNegative(values: readonly number[]): void {
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`weights must be finite and non-negative, got ${value}`);
    }
  }
}

/**
 * Turns volumes into shares of their total.
 *
 * A total of zero cannot produce shares, so every entry gets an equal share
 * instead of a division by zero.
 */
export function sharesOf(values: readonly number[]): number[] {
  assertNonNegative(values);
  if (values.length === 0) {
    return [];
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return values.map(() => 1 / values.length);
  }
  return values.map((value) => value / total);
}

/** Share of the remaining budget for one pool member, by volume or equally. */
function shareFromBudget(
  budget: number,
  poolTotal: number,
  value: number,
  poolSize: number,
): number {
  return poolTotal > 0 ? (budget * value) / poolTotal : budget / poolSize;
}

/**
 * Caps any share above `cap` and redistributes the excess over the rest.
 *
 * The cap is raised to the equal share when it cannot be honoured: with five
 * constituents no member can carry less than a fifth, and a cap below that
 * would leave weight unassigned.
 */
export function capShares(shares: readonly number[], cap: number): number[] {
  assertNonNegative(shares);
  if (shares.length === 0) {
    return [];
  }
  const limit = Math.max(cap, 1 / shares.length);
  const out = shares.map(() => 0);
  let pool = shares.map((_, index) => index);
  let budget = 1;

  while (pool.length > 0) {
    const poolTotal = pool.reduce((sum, index) => sum + (shares[index] ?? 0), 0);
    const atLimit = pool.filter(
      (index) =>
        shareFromBudget(budget, poolTotal, shares[index] ?? 0, pool.length) > limit + CAP_EPSILON,
    );
    if (atLimit.length === 0) {
      for (const index of pool) {
        out[index] = shareFromBudget(budget, poolTotal, shares[index] ?? 0, pool.length);
      }
      break;
    }
    for (const index of atLimit) {
      out[index] = limit;
      budget -= limit;
    }
    pool = pool.filter((index) => !atLimit.includes(index));
  }
  return out;
}

/**
 * Weighted mean over the constituents that scored.
 *
 * Weights are renormalised across the scored set rather than treated as zero
 * for the missing ones. A missing constituent means the volume could not be
 * measured, and scoring it at zero would report a fall in attention that never
 * happened; `weightScored` says how much of the index is actually represented.
 */
export function weightedScore(entries: readonly WeightedScore[]): WeightedAggregate {
  const intended = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  const scored = entries.filter(
    (entry): entry is { weight: number; score: number } => entry.score !== null && entry.weight > 0,
  );
  const scoredWeight = scored.reduce((sum, entry) => sum + entry.weight, 0);
  if (intended <= 0 || scoredWeight <= 0) {
    return { score: null, weightScored: 0 };
  }
  const total = scored.reduce((sum, entry) => sum + entry.weight * entry.score, 0);
  return { score: total / scoredWeight, weightScored: scoredWeight / intended };
}

/** Rounds weights to the published precision, keeping the sum at exactly one. */
export function roundWeights(weights: readonly number[]): number[] {
  if (weights.length === 0) {
    return [];
  }
  const rounded = weights.map((weight) => Math.round(weight * WEIGHT_SCALE) / WEIGHT_SCALE);
  const sum = rounded.reduce((total, weight) => total + weight, 0);
  const drift = Math.round((1 - sum) * WEIGHT_SCALE) / WEIGHT_SCALE;
  if (drift === 0) {
    return rounded;
  }
  let largest = 0;
  rounded.forEach((weight, index) => {
    if (weight > (rounded[largest] ?? 0)) {
      largest = index;
    }
  });
  rounded[largest] = Math.round(((rounded[largest] ?? 0) + drift) * WEIGHT_SCALE) / WEIGHT_SCALE;
  return rounded;
}
