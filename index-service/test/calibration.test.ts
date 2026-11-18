import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDefinition } from '../src/app/calibration.ts';
import type { EntityDefinition } from '../src/config/entities.ts';
import type { SignalDefinition } from '../src/config/signals.ts';
import { addDays } from '../src/domain/dates.ts';
import type { DailyObservation } from '../src/domain/observation.ts';
import { PULSE_SCORING_COUNTS_V1, PULSE_SCORING_V1 } from '../src/domain/scoring.ts';

const BASE_DAY = '2026-11-15';

const ENTITIES: readonly EntityDefinition[] = ['alpha', 'beta', 'gamma'].map((id) => ({
  id,
  label: id,
  wikipediaArticle: id,
  hackerNewsQuery: id,
}));

function signal(id: string, weight: number, counts = false): SignalDefinition {
  return {
    id,
    label: id,
    unit: counts ? 'stories' : 'views',
    weight,
    scoring: counts ? PULSE_SCORING_COUNTS_V1 : PULSE_SCORING_V1,
    fetchSeries: () => {
      throw new Error('calibration must not fetch');
    },
  };
}

/** `days` daily observations ending on BASE_DAY with a constant value. */
function flat(value: number, days = 20): DailyObservation[] {
  return Array.from({ length: days }, (_, index) => ({
    day: addDays(BASE_DAY, index - (days - 1)),
    value,
  }));
}

function observations(entries: Record<string, DailyObservation[]>): Map<string, DailyObservation[]> {
  return new Map(Object.entries(entries));
}

describe('buildDefinition', () => {
  it('freezes the base-period level of each constituent as its anchor', () => {
    const definition = buildDefinition({
      id: 'test-v1',
      baseDay: BASE_DAY,
      entities: ENTITIES,
      signals: [signal('pageviews', 1)],
      observations: observations({
        'pageviews/alpha': flat(100),
        'pageviews/beta': flat(100),
        'pageviews/gamma': flat(800),
      }),
    });
    assert.deepEqual(
      definition.signals[0]?.constituents.map((entry) => entry.anchor),
      [100, 100, 800],
    );
  });

  it('weights constituents by volume share under a cap', () => {
    const definition = buildDefinition({
      id: 'test-v1',
      baseDay: BASE_DAY,
      entities: ENTITIES,
      signals: [signal('pageviews', 1)],
      observations: observations({
        'pageviews/alpha': flat(100),
        'pageviews/beta': flat(100),
        'pageviews/gamma': flat(800),
      }),
      weightCap: 0.4,
    });
    const weights = definition.signals[0]?.constituents.map((entry) => entry.weight) ?? [];
    assert.deepEqual(weights, [0.3, 0.3, 0.4]);
    assert.equal(Math.round(weights.reduce((sum, weight) => sum + weight, 0) * 1000) / 1000, 1);
  });

  it('ignores days outside the base period', () => {
    const values = [...flat(100), { day: addDays(BASE_DAY, 5), value: 1_000_000 }];
    const definition = buildDefinition({
      id: 'test-v1',
      baseDay: BASE_DAY,
      entities: ENTITIES.slice(0, 1),
      signals: [signal('pageviews', 1)],
      observations: observations({ 'pageviews/alpha': values }),
    });
    assert.equal(definition.signals[0]?.constituents[0]?.anchor, 100);
  });

  it('uses the smoothed mean for count signals', () => {
    const definition = buildDefinition({
      id: 'test-v1',
      baseDay: BASE_DAY,
      entities: ENTITIES.slice(0, 1),
      signals: [signal('stories', 1, true)],
      observations: observations({ 'stories/alpha': flat(0, 10) }),
    });
    // (0 * 10 + 1) / (10 + 1), the prior keeping a quiet series off zero,
    // published to four decimals.
    assert.equal(definition.signals[0]?.constituents[0]?.anchor, 0.0909);
  });

  it('records the base period and the calibration window', () => {
    const definition = buildDefinition({
      id: 'test-v1',
      baseDay: BASE_DAY,
      entities: ENTITIES.slice(0, 1),
      signals: [signal('pageviews', 1)],
      observations: observations({ 'pageviews/alpha': flat(100) }),
      calibrationDays: 90,
    });
    assert.equal(definition.baseDay, BASE_DAY);
    assert.equal(definition.calibrationDays, 90);
    assert.equal(definition.signals[0]?.scoring.baselineWindowDays, 90);
  });

  it('refuses to calibrate on too few days', () => {
    assert.throws(
      () =>
        buildDefinition({
          id: 'test-v1',
          baseDay: BASE_DAY,
          entities: ENTITIES.slice(0, 1),
          signals: [signal('pageviews', 1)],
          observations: observations({ 'pageviews/alpha': flat(100, 3) }),
        }),
      /need 7/,
    );
  });

  it('refuses to calibrate a constituent it has no observations for', () => {
    assert.throws(
      () =>
        buildDefinition({
          id: 'test-v1',
          baseDay: BASE_DAY,
          entities: ENTITIES.slice(0, 1),
          signals: [signal('pageviews', 1)],
          observations: observations({ 'pageviews/other': flat(100) }),
        }),
      /missing observations/,
    );
  });

  it('refuses signal weights that do not sum to one', () => {
    assert.throws(
      () =>
        buildDefinition({
          id: 'test-v1',
          baseDay: BASE_DAY,
          entities: ENTITIES.slice(0, 1),
          signals: [signal('pageviews', 0.8)],
          observations: observations({ 'pageviews/alpha': flat(100) }),
        }),
      /sum to 1/,
    );
  });
});
