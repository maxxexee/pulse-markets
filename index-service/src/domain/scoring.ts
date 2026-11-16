import type { DailyObservation } from './observation.ts';

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
}

/** Scoring parameters for index version 1. Frozen once a market exists on it. */
export const PULSE_SCORING_V1: ScoringConfig = {
  name: 'pulse-level-v1',
  baselineWindowDays: 30,
  minBaselineDays: 7,
  midpoint: 50,
  pointsPerDoubling: 12.5,
};

export type InsufficientReason =
  | 'missing-target-day'
  | 'too-few-baseline-days'
  | 'zero-baseline';

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
      readonly views: number;
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
      readonly views: number | null;
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
  views: number | null,
  baselineDays: number,
  reason: InsufficientReason,
): EntityScore {
  return { status: 'insufficient-data', entityId, day, views, baselineDays, reason };
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
    .map((entry) => entry.views);

  if (target === undefined) {
    return unscored(entityId, targetDay, null, baselineWindow.length, 'missing-target-day');
  }
  if (baselineWindow.length < config.minBaselineDays) {
    return unscored(entityId, targetDay, target.views, baselineWindow.length, 'too-few-baseline-days');
  }

  const baseline = median(baselineWindow);
  if (baseline <= 0) {
    return unscored(entityId, targetDay, target.views, baselineWindow.length, 'zero-baseline');
  }

  const level = target.views / baseline;
  return {
    status: 'scored',
    entityId,
    day: targetDay,
    views: target.views,
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
