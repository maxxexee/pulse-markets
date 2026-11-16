import type { DailyObservation } from './observation.ts';

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

/** Mention scoring. Sparse and frequently zero, so the baseline is smoothed. */
export const PULSE_SCORING_MENTIONS_V1: ScoringConfig = {
  name: 'pulse-level-mentions-v1',
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
  | 'too-few-baseline-days'
  | 'zero-baseline'
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
export function scoreFromLevel(level: number, config: ScoringConfig): number {
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

/**
 * Scores one entity for one UTC day against its own trailing baseline.
 *
 * Each entity is measured against itself, never against other entities, so a
 * permanently quiet entity can still spike and a permanently loud one still has
 * to earn its points.
 */
export function scoreEntity(
  entityId: string,
  observations: readonly DailyObservation[],
  targetDay: string,
  config: ScoringConfig = PULSE_SCORING_V1,
): EntityScore {
  const ordered = [...observations].sort((a, b) => a.day.localeCompare(b.day));
  const target = ordered.find((entry) => entry.day === targetDay);
  const baselineWindow = ordered
    .filter((entry) => entry.day < targetDay)
    .slice(-config.baselineWindowDays)
    .map((entry) => entry.value);

  if (target === undefined) {
    return unscored(entityId, targetDay, null, baselineWindow.length, 'missing-target-day');
  }
  if (baselineWindow.length < config.minBaselineDays) {
    return unscored(entityId, targetDay, target.value, baselineWindow.length, 'too-few-baseline-days');
  }
  if (target.value < config.minTargetValue) {
    return unscored(entityId, targetDay, target.value, baselineWindow.length, 'below-minimum-volume');
  }

  const baseline = baselineOf(baselineWindow, config);
  if (baseline <= 0) {
    return unscored(entityId, targetDay, target.value, baselineWindow.length, 'zero-baseline');
  }

  const level = target.value / baseline;
  return {
    status: 'scored',
    entityId,
    day: targetDay,
    value: target.value,
    baseline: round2(baseline),
    baselineDays: baselineWindow.length,
    level: round2(level),
    score: round2(scoreFromLevel(level, config)),
  };
}

/** Averages the scored entities into the published index level. */
export function aggregateIndex(scores: readonly EntityScore[]): IndexAggregate {
  const scored = scores.filter((score) => score.status === 'scored');
  if (scored.length === 0) {
    return { score: null, scoredEntities: 0, totalEntities: scores.length };
  }
  const total = scored.reduce((sum, score) => sum + score.score, 0);
  return {
    score: round2(total / scored.length),
    scoredEntities: scored.length,
    totalEntities: scores.length,
  };
}

/**
 * Combines independent signal indices into the headline index.
 *
 * Each signal index is the mean of its own scored entities, so this weights the
 * signals equally rather than weighting by how many entities each happened to
 * score. A signal that scored nothing is skipped instead of contributing a zero.
 */
export function combineIndices(indices: readonly (IndexAggregate | null)[]): IndexAggregate {
  const usable = indices.filter(
    (index): index is IndexAggregate => index !== null && index.score !== null,
  );
  if (usable.length === 0) {
    return { score: null, scoredEntities: 0, totalEntities: 0 };
  }
  const total = usable.reduce((sum, index) => sum + (index.score ?? 0), 0);
  return {
    score: round2(total / usable.length),
    scoredEntities: usable.reduce((sum, index) => sum + index.scoredEntities, 0),
    totalEntities: usable.reduce((sum, index) => sum + index.totalEntities, 0),
  };
}
