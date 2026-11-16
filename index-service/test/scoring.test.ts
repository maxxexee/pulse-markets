import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays } from '../src/domain/dates.ts';
import {
  PULSE_SCORING_COUNTS_V1,
  PULSE_SCORING_V1,
  aggregateIndex,
  baselineOf,
  combineIndices,
  median,
  scoreEntity,
  scoreFromLevel,
  smoothedMean,
} from '../src/domain/scoring.ts';
import type { DailyObservation } from '../src/domain/observation.ts';

const TARGET = '2026-11-15';

/** Builds `count` consecutive days ending on the day before TARGET. */
function baselineHistory(value: number, count = 20): DailyObservation[] {
  const out: DailyObservation[] = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    out.push({ day: addDays(TARGET, -offset), value });
  }
  return out;
}

function withTarget(value: number, history = baselineHistory(100)): DailyObservation[] {
  return [...history, { day: TARGET, value }];
}

describe('median', () => {
  it('returns the middle value for odd counts', () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  it('averages the two middle values for even counts', () => {
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });

  it('rejects an empty list', () => {
    assert.throws(() => median([]), /at least one value/);
  });
});

describe('smoothedMean', () => {
  it('adds the prior to both the total and the day count', () => {
    assert.equal(smoothedMean([0, 0, 0, 0], 1), 0.2);
    assert.equal(smoothedMean([1, 1], 1), 1);
  });

  it('rejects an empty list', () => {
    assert.throws(() => smoothedMean([], 1), /at least one value/);
  });
});

describe('baselineOf', () => {
  it('uses the median for dense series', () => {
    assert.equal(baselineOf([100, 100, 100, 10_000], PULSE_SCORING_V1), 100);
  });

  it('uses the smoothed mean for sparse series', () => {
    assert.equal(baselineOf([0, 0, 0, 0], PULSE_SCORING_COUNTS_V1), 0.2);
  });
});

describe('scoreFromLevel', () => {
  it('scores attention at baseline as the midpoint', () => {
    assert.equal(scoreFromLevel(1, PULSE_SCORING_V1), 50);
  });

  it('adds points per doubling', () => {
    assert.equal(scoreFromLevel(2, PULSE_SCORING_V1), 62.5);
    assert.equal(scoreFromLevel(0.5, PULSE_SCORING_V1), 37.5);
    assert.equal(scoreFromLevel(16, PULSE_SCORING_V1), 100);
    assert.equal(scoreFromLevel(1 / 16, PULSE_SCORING_V1), 0);
  });

  it('clamps beyond sixteen times baseline', () => {
    assert.equal(scoreFromLevel(1000, PULSE_SCORING_V1), 100);
    assert.equal(scoreFromLevel(0.0001, PULSE_SCORING_V1), 0);
  });
});

describe('scoreEntity', () => {
  it('scores a day equal to its trailing baseline', () => {
    const score = scoreEntity('nvidia', withTarget(100), TARGET);
    assert.equal(score.status, 'scored');
    assert.equal(score.status === 'scored' && score.score, 50);
    assert.equal(score.status === 'scored' && score.level, 1);
  });

  it('scores a spike against the baseline', () => {
    const score = scoreEntity('nvidia', withTarget(400), TARGET);
    assert.equal(score.status === 'scored' && score.score, 75);
    assert.equal(score.status === 'scored' && score.level, 4);
  });

  it('excludes the target day from its own baseline', () => {
    const history = baselineHistory(100, 10);
    const score = scoreEntity('nvidia', withTarget(1000, history), TARGET);
    assert.equal(score.status, 'scored');
    assert.equal(score.status === 'scored' && score.baseline, 100);
  });

  it('uses at most the configured baseline window', () => {
    const long = [
      ...baselineHistory(10_000, 10),
      ...baselineHistory(100, PULSE_SCORING_V1.baselineWindowDays),
    ];
    const score = scoreEntity('nvidia', withTarget(100, long), TARGET);
    assert.equal(score.status === 'scored' && score.baseline, 100);
    assert.equal(score.status === 'scored' && score.baselineDays, PULSE_SCORING_V1.baselineWindowDays);
  });

  it('reports a missing target day instead of guessing', () => {
    const score = scoreEntity('nvidia', baselineHistory(100), TARGET);
    assert.equal(score.status, 'insufficient-data');
    assert.equal(score.status === 'insufficient-data' && score.reason, 'missing-target-day');
  });

  it('refuses to score on too little history', () => {
    const score = scoreEntity('nvidia', withTarget(100, baselineHistory(100, 3)), TARGET);
    assert.equal(score.status, 'insufficient-data');
    assert.equal(score.status === 'insufficient-data' && score.reason, 'too-few-baseline-days');
  });

  it('refuses to divide by a zero baseline', () => {
    const score = scoreEntity('nvidia', withTarget(50, baselineHistory(0, 10)), TARGET);
    assert.equal(score.status, 'insufficient-data');
    assert.equal(score.status === 'insufficient-data' && score.reason, 'zero-baseline');
  });

  it('refuses to score a sparse day below the minimum volume', () => {
    const score = scoreEntity(
      'solana',
      withTarget(2, baselineHistory(0, 10)),
      TARGET,
      PULSE_SCORING_COUNTS_V1,
    );
    assert.equal(score.status, 'insufficient-data');
    assert.equal(score.status === 'insufficient-data' && score.reason, 'below-minimum-volume');
  });

  it('scores a sparse mention spike once the volume floor is met', () => {
    const history = baselineHistory(0, 10);
    history[history.length - 1] = { day: addDays(TARGET, -1), value: 1 };
    const score = scoreEntity('solana', withTarget(5, history), TARGET, PULSE_SCORING_COUNTS_V1);
    assert.equal(score.status, 'scored');
    // Baseline (1 + 1) / 11 = 0.1818, level 27.5, which clamps to 100.
    assert.equal(score.status === 'scored' && score.score, 100);
    assert.equal(score.status === 'scored' && score.value, 5);
  });
});

describe('aggregateIndex', () => {
  it('averages the scored entities and ignores unscored ones', () => {
    const scored = scoreEntity('a', withTarget(200), TARGET);
    const other = scoreEntity('b', withTarget(100), TARGET);
    const missing = scoreEntity('c', baselineHistory(100), TARGET);
    const index = aggregateIndex([scored, other, missing]);
    assert.equal(index.score, 56.25);
    assert.equal(index.scoredEntities, 2);
    assert.equal(index.totalEntities, 3);
  });

  it('reports a null score when nothing could be scored', () => {
    const missing = scoreEntity('c', baselineHistory(100), TARGET);
    const index = aggregateIndex([missing]);
    assert.equal(index.score, null);
    assert.equal(index.scoredEntities, 0);
  });
});

describe('combineIndices', () => {
  it('weights each signal equally rather than by entity count', () => {
    const combined = combineIndices([
      { score: 80, scoredEntities: 7, totalEntities: 7 },
      { score: 40, scoredEntities: 1, totalEntities: 7 },
    ]);
    assert.equal(combined.score, 60);
    assert.equal(combined.scoredEntities, 8);
    assert.equal(combined.totalEntities, 14);
  });

  it('skips a signal that scored nothing instead of counting it as zero', () => {
    const combined = combineIndices([
      { score: 80, scoredEntities: 7, totalEntities: 7 },
      { score: null, scoredEntities: 0, totalEntities: 7 },
      null,
    ]);
    assert.equal(combined.score, 80);
  });

  it('reports a null score when no signal scored', () => {
    assert.equal(combineIndices([null, { score: null, scoredEntities: 0, totalEntities: 7 }]).score, null);
  });
});
