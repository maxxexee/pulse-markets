import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PULSE_SCORING_COUNTS_V1,
  PULSE_SCORING_V1,
  baselineOf,
  median,
  scoreAgainstAnchor,
  scoreFromLevel,
  smoothedMean,
  type AnchorScoring,
} from '../src/scoring.ts';

const TARGET = '2026-11-15';
const PAGEVIEWS: AnchorScoring = {
  midpoint: PULSE_SCORING_V1.midpoint,
  pointsPerDoubling: PULSE_SCORING_V1.pointsPerDoubling,
  minTargetValue: PULSE_SCORING_V1.minTargetValue,
  anchorDays: 180,
};
const COUNTS: AnchorScoring = {
  midpoint: PULSE_SCORING_COUNTS_V1.midpoint,
  pointsPerDoubling: PULSE_SCORING_COUNTS_V1.pointsPerDoubling,
  minTargetValue: PULSE_SCORING_COUNTS_V1.minTargetValue,
  anchorDays: 180,
};

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
  it('scores attention at the anchor as the midpoint', () => {
    assert.equal(scoreFromLevel(1, PULSE_SCORING_V1), 50);
  });

  it('adds points per doubling', () => {
    assert.equal(scoreFromLevel(2, PULSE_SCORING_V1), 62.5);
    assert.equal(scoreFromLevel(0.5, PULSE_SCORING_V1), 37.5);
    assert.equal(scoreFromLevel(16, PULSE_SCORING_V1), 100);
    assert.equal(scoreFromLevel(1 / 16, PULSE_SCORING_V1), 0);
  });

  it('clamps beyond sixteen times the anchor', () => {
    assert.equal(scoreFromLevel(1000, PULSE_SCORING_V1), 100);
    assert.equal(scoreFromLevel(0.0001, PULSE_SCORING_V1), 0);
  });
});

describe('scoreAgainstAnchor', () => {
  it('scores a day equal to its anchor at the midpoint', () => {
    const score = scoreAgainstAnchor('nvidia', 100, 100, TARGET, PAGEVIEWS);
    assert.equal(score.status, 'scored');
    assert.equal(score.status === 'scored' && score.score, 50);
    assert.equal(score.status === 'scored' && score.level, 1);
  });

  it('scores a spike against the anchor, not against the day itself', () => {
    const score = scoreAgainstAnchor('nvidia', 400, 100, TARGET, PAGEVIEWS);
    assert.equal(score.status === 'scored' && score.score, 75);
    assert.equal(score.status === 'scored' && score.level, 4);
  });

  it('scores the same volume the same way on any day of the definition', () => {
    const first = scoreAgainstAnchor('nvidia', 250, 100, '2026-01-02', PAGEVIEWS);
    const later = scoreAgainstAnchor('nvidia', 250, 100, '2026-12-30', PAGEVIEWS);
    assert.equal(first.status === 'scored' && first.score, later.status === 'scored' && later.score);
    assert.equal(first.status === 'scored' && first.baseline, 100);
  });

  it('reports a missing day instead of guessing', () => {
    const score = scoreAgainstAnchor('nvidia', null, 100, TARGET, PAGEVIEWS);
    assert.equal(score.status, 'insufficient-data');
    assert.equal(score.status === 'insufficient-data' && score.reason, 'missing-target-day');
  });

  it('refuses to divide by a null or zero anchor', () => {
    const zero = scoreAgainstAnchor('nvidia', 50, 0, TARGET, PAGEVIEWS);
    assert.equal(zero.status === 'insufficient-data' && zero.reason, 'no-anchor');
    const broken = scoreAgainstAnchor('nvidia', 50, Number.NaN, TARGET, PAGEVIEWS);
    assert.equal(broken.status === 'insufficient-data' && broken.reason, 'no-anchor');
  });

  it('refuses to score a sparse day below the minimum volume', () => {
    const score = scoreAgainstAnchor('solana', 2, 0.5, TARGET, COUNTS);
    assert.equal(score.status, 'insufficient-data');
    assert.equal(score.status === 'insufficient-data' && score.reason, 'below-minimum-volume');
  });

  it('scores a sparse mention spike once the volume floor is met', () => {
    const score = scoreAgainstAnchor('solana', 5, 0.1818, TARGET, COUNTS);
    assert.equal(score.status, 'scored');
    assert.equal(score.status === 'scored' && score.value, 5);
    // 5 / 0.1818 is 27.5x the anchor, which is past the top of the curve.
    assert.equal(score.status === 'scored' && score.score, 100);
  });

  it('reports the anchor age with each score', () => {
    const score = scoreAgainstAnchor('nvidia', 100, 100, TARGET, PAGEVIEWS);
    assert.equal(score.status === 'scored' && score.baselineDays, 180);
  });
});
