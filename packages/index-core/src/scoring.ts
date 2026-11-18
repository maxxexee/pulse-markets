
/** How the trailing baseline is derived from the window. */
export type BaselineMethod = 'median' | 'smoothed-mean';

/**
 * Fixed parameters of the scoring formula.
 *
 * These values are part of the published index definition. Changing any of them
 * requires a new `name`, because a snapshot must always be interpretable
 * alongside the exact formula that produced it.
 */
export interface ScoringConfig {
  /** Human-readable formula version, stored in every snapshot. */
  readonly name: string;
  /** Days of history used to establish the baseline, ending the day before the target day. */
  readonly baselineWindowDays: number;
  /** Baselines shorter than this are not scored, to avoid noise on new entities. */
  readonly minBaselineDays: number;
  /** Score assigned to attention exactly equal to the baseline. */
  readonly midpoint: number;
  /**
   * Score points added per doubling of attention above the baseline.
   *
   * At 12.5 the scale spans a sixteenth of baseline (0) to sixteen times
   * baseline (100). A wider span matters: news spikes routinely exceed four
   * times baseline, and a narrower curve would peg several entities at 100 and
   * leave the published index unable to distinguish them.
   */
  readonly pointsPerDoubling: number;
  /**
   * Median resists a single viral day inside the baseline window, but for
   * sparse counts it collapses to zero and makes the entity unscoreable. The
   * smoothed mean is used where counts are small and many days are zero.
   */
  readonly baselineMethod: BaselineMethod;
  /**
   * Prior count added to the smoothed mean, equivalent to pretending the entity
   * had `baselinePrior` mentions spread over `baselinePrior` days. Keeps a
   * single quiet day from producing an infinite ratio.
   */
  readonly baselinePrior: number;
  /**
   * Minimum target-day count before the day is scored. Below this, a one or two
   * unit change is noise rather than attention, and a sparse series would emit
   * large scores from meaningless differences.
   */
  readonly minTargetValue: number;
}

/** Pageview scoring. Dense daily data, so a median baseline is meaningful. */
export const PULSE_SCORING_V1: ScoringConfig = {
  name: 'pulse-level-v1',
  baselineWindowDays: 30,
  minBaselineDays: 7,
  midpoint: 50,
  pointsPerDoubling: 12.5,
  baselineMethod: 'median',
  baselinePrior: 0,
  minTargetValue: 0,
};

/**
 * Count scoring, shared by every signal that counts discrete items per day
 * (stories, news articles). Sparse and frequently zero, so the baseline is
 * smoothed rather than taken as a median.
 */
export const PULSE_SCORING_COUNTS_V1: ScoringConfig = {
  name: 'pulse-level-counts-v1',
  baselineWindowDays: 30,
  minBaselineDays: 7,
  midpoint: 50,
  pointsPerDoubling: 12.5,
  baselineMethod: 'smoothed-mean',
  baselinePrior: 1,
  minTargetValue: 3,
};

export type InsufficientReason =
  | 'missing-target-day'
  | 'no-anchor'
  | 'below-minimum-volume';

/**
 * Result of scoring one entity for one day.
 *
 * The two cases are distinct types so a caller cannot read a score that was
 * never produced; `null` scores are represented by the absence of the scored
 * variant rather than by a null field.
 */
export type EntityScore =
  | {
      readonly status: 'scored';
      readonly entityId: string;
      readonly day: string;
      /** Raw target-day count: pageviews or mentions, depending on the signal. */
      readonly value: number;
      readonly baseline: number;
      readonly baselineDays: number;
      /** Attention relative to baseline, where 1.0 means exactly on baseline. */
      readonly level: number;
      /** Index points, 0 to 100. */
      readonly score: number;
    }
  | {
      readonly status: 'insufficient-data';
      readonly entityId: string;
      readonly day: string;
      readonly value: number | null;
      readonly baselineDays: number;
      readonly reason: InsufficientReason;
    };

export interface IndexAggregate {
  /** Mean score of the entities that could be scored, null if none could. */
  readonly score: number | null;
  readonly scoredEntities: number;
  readonly totalEntities: number;
}

/** Median of a non-empty list. Throws on an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('median requires at least one value');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Mean with an additive prior, used for sparse count series. */
export function smoothedMean(values: readonly number[], prior: number): number {
  if (values.length === 0) {
    throw new Error('smoothedMean requires at least one value');
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return (total + prior) / (values.length + prior);
}

/** Trailing baseline for one entity, using the method named in the config. */
export function baselineOf(values: readonly number[], config: ScoringConfig): number {
  return config.baselineMethod === 'median'
    ? median(values)
    : smoothedMean(values, config.baselinePrior);
}

/**
 * Maps attention relative to baseline onto 0 to 100.
 *
 * The curve is logarithmic, so equal multiples produce equal increments and a
 * 10x spike cannot drown out every other entity in the aggregate. Attention at
 * the baseline scores the midpoint, and the result is clamped at both ends.
 */
export function scoreFromLevel(
  level: number,
  config: { readonly midpoint: number; readonly pointsPerDoubling: number },
): number {
  if (!Number.isFinite(level) || level <= 0) {
    return 0;
  }
  const raw = config.midpoint + config.pointsPerDoubling * Math.log2(level);
  return Math.min(100, Math.max(0, raw));
}

/** Rounds to two decimals, the precision stored and displayed. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function unscored(
  entityId: string,
  day: string,
  value: number | null,
  baselineDays: number,
  reason: InsufficientReason,
): EntityScore {
  return { status: 'insufficient-data', entityId, day, value, baselineDays, reason };
}

/** Everything a score needs from the definition, plus the anchor's provenance. */
export interface AnchorScoring {
  readonly midpoint: number;
  readonly pointsPerDoubling: number;
  readonly minTargetValue: number;
  /** Days of history behind the anchor, reported with each score. */
  readonly anchorDays: number;
}

/**
 * Scores one entity for one UTC day against its frozen anchor.
 *
 * The anchor comes from the published definition and does not move within a
 * definition version, so a level means the same thing on every day of that
 * version. Each entity is still measured against itself, never against other
 * entities, so a quiet entity can spike and a loud one still has to earn points.
 */
export function scoreAgainstAnchor(
  entityId: string,
  value: number | null,
  anchor: number,
  targetDay: string,
  config: AnchorScoring,
): EntityScore {
  if (value === null) {
    return unscored(entityId, targetDay, null, config.anchorDays, 'missing-target-day');
  }
  if (!Number.isFinite(anchor) || anchor <= 0) {
    return unscored(entityId, targetDay, value, config.anchorDays, 'no-anchor');
  }
  if (value < config.minTargetValue) {
    return unscored(entityId, targetDay, value, config.anchorDays, 'below-minimum-volume');
  }

  const level = value / anchor;
  return {
    status: 'scored',
    entityId,
    day: targetDay,
    value,
    baseline: round2(anchor),
    baselineDays: config.anchorDays,
    level: round2(level),
    score: round2(scoreFromLevel(level, config)),
  };
}
