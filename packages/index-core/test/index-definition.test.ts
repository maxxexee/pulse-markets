import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFINITION_SCHEMA, definitionDigest } from '../src/index-definition.ts';
import { PULSE_SCORING_V1 } from '../src/scoring.ts';

const BASE = {
  schema: DEFINITION_SCHEMA,
  id: 'pulse-test-v1',
  baseDay: '2026-11-15',
  calibrationDays: 180,
  constituentWeightCap: 0.25,
  signals: [
    {
      id: 'pageviews',
      label: 'Pageviews',
      unit: 'views',
      weight: 1,
      scoring: PULSE_SCORING_V1,
      constituents: [{ entityId: 'alpha', anchor: 1000, weight: 1 }],
    },
  ],
} as const;

describe('definitionDigest', () => {
  it('is a hex sha256', () => {
    assert.match(definitionDigest(BASE), /^[0-9a-f]{64}$/);
  });

  it('ignores key insertion order', () => {
    const reordered = {
      signals: BASE.signals,
      constituentWeightCap: BASE.constituentWeightCap,
      calibrationDays: BASE.calibrationDays,
      baseDay: BASE.baseDay,
      id: BASE.id,
      schema: BASE.schema,
    };
    assert.equal(definitionDigest(reordered), definitionDigest(BASE));
  });

  it('changes when an anchor changes', () => {
    const moved = {
      ...BASE,
      signals: [
        {
          ...BASE.signals[0],
          constituents: [{ entityId: 'alpha', anchor: 1001, weight: 1 }],
        },
      ],
    };
    assert.notEqual(definitionDigest(moved), definitionDigest(BASE));
  });

  it('changes when a weight changes', () => {
    const reweighted = {
      ...BASE,
      signals: [{ ...BASE.signals[0], weight: 0.5 }],
    };
    assert.notEqual(definitionDigest(reweighted), definitionDigest(BASE));
  });

  it('is stable across repeated calls', () => {
    assert.equal(definitionDigest(BASE), definitionDigest(BASE));
  });
});
