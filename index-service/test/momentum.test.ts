import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MOMENTUM_WINDOW_DAYS, momentumFrom } from '../src/domain/momentum.ts';

const REFERENCE_DAY = '2026-11-08';

describe('momentumFrom', () => {
  it('reports flat movement as 50', () => {
    assert.deepEqual(momentumFrom(62.5, 62.5, REFERENCE_DAY), {
      windowDays: MOMENTUM_WINDOW_DAYS,
      referenceDay: REFERENCE_DAY,
      delta: 0,
      score: 50,
    });
  });

  it('translates index points gained into momentum points', () => {
    const momentum = momentumFrom(70, 45.5, REFERENCE_DAY);
    assert.equal(momentum?.delta, 24.5);
    assert.equal(momentum?.score, 74.5);
  });

  it('goes below 50 when attention is cooling', () => {
    const momentum = momentumFrom(30, 55, REFERENCE_DAY);
    assert.equal(momentum?.delta, -25);
    assert.equal(momentum?.score, 25);
  });

  it('clamps a collapse at 0 and a surge at 100', () => {
    assert.equal(momentumFrom(0, 90, REFERENCE_DAY)?.score, 0);
    assert.equal(momentumFrom(100, 5, REFERENCE_DAY)?.score, 100);
  });

  it('returns null rather than guessing when a score is missing', () => {
    assert.equal(momentumFrom(null, 50, REFERENCE_DAY), null);
    assert.equal(momentumFrom(50, null, REFERENCE_DAY), null);
  });

  it('rounds to two decimals', () => {
    const momentum = momentumFrom(62.567, 62.5, REFERENCE_DAY);
    assert.equal(momentum?.delta, 0.07);
  });
});
