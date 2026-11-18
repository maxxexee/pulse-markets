import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capShares, roundWeights, sharesOf, weightedScore } from '../src/weights.ts';

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('sharesOf', () => {
  it('turns volumes into shares of the total', () => {
    const shares = sharesOf([40, 30, 30]);
    assert.deepEqual(shares, [0.4, 0.3, 0.3]);
    assert.equal(sum(shares), 1);
  });

  it('falls back to equal shares when there is no volume at all', () => {
    assert.deepEqual(sharesOf([0, 0, 0, 0]), [0.25, 0.25, 0.25, 0.25]);
  });

  it('rejects negative or non-finite volumes', () => {
    assert.throws(() => sharesOf([1, -1]), /non-negative/);
    assert.throws(() => sharesOf([Number.NaN]), /non-negative/);
  });
});

describe('capShares', () => {
  it('caps the largest member and redistributes the excess', () => {
    const capped = capShares([0.9, 0.05, 0.05], 0.4);
    assert.deepEqual(capped, [0.4, 0.3, 0.3]);
    assert.ok(Math.abs(sum(capped) - 1) < 1e-12);
  });

  it('caps as many members as the limit requires', () => {
    const capped = capShares([0.7, 0.2, 0.05, 0.05], 0.3);
    assert.ok(Math.abs(sum(capped) - 1) < 1e-12);
    assert.ok(capped.every((share) => share <= 0.3 + 1e-9));
  });

  it('leaves shares alone when none exceeds the cap', () => {
    assert.deepEqual(capShares([0.26, 0.25, 0.24, 0.25], 0.3), [0.26, 0.25, 0.24, 0.25]);
  });

  it('raises an impossible cap to the equal share', () => {
    const capped = capShares([0.9, 0.05, 0.05], 0.1);
    assert.ok(capped.every((share) => Math.abs(share - 1 / 3) < 1e-12));
  });

  it('keeps two members summing to one', () => {
    assert.deepEqual(capShares([0.75, 0.25], 0.5), [0.5, 0.5]);
  });
});

describe('weightedScore', () => {
  it('takes the weighted mean of the scored constituents', () => {
    const result = weightedScore([
      { weight: 0.75, score: 60 },
      { weight: 0.25, score: 20 },
    ]);
    assert.equal(result.score, 50);
    assert.equal(result.weightScored, 1);
  });

  it('renormalises over the constituents that scored', () => {
    const result = weightedScore([
      { weight: 0.6, score: 60 },
      { weight: 0.2, score: 20 },
      { weight: 0.2, score: null },
    ]);
    assert.equal(result.score, 50);
    assert.equal(result.weightScored, 0.8);
  });

  it('reports nothing scored rather than a zero index', () => {
    const result = weightedScore([
      { weight: 0.5, score: null },
      { weight: 0.5, score: null },
    ]);
    assert.equal(result.score, null);
    assert.equal(result.weightScored, 0);
  });

  it('ignores zero-weight constituents with a score', () => {
    const result = weightedScore([
      { weight: 1, score: 40 },
      { weight: 0, score: 100 },
    ]);
    assert.equal(result.score, 40);
  });
});

describe('roundWeights', () => {
  it('keeps the sum at exactly one after rounding', () => {
    const rounded = roundWeights([1 / 3, 1 / 3, 1 / 3]);
    assert.equal(sum(rounded), 1);
    assert.equal(rounded.length, 3);
  });

  it('rounds to six decimals', () => {
    assert.deepEqual(roundWeights([0.1234567, 0.8765433]), [0.123457, 0.876543]);
  });

  it('handles an empty list', () => {
    assert.deepEqual(roundWeights([]), []);
  });
});
