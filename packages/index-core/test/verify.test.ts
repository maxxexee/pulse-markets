import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityScore } from '../src/scoring.ts';

type ScoredEntity = Extract<EntityScore, { status: 'scored' }>;
import { SNAPSHOT_SCHEMA, type IndexSnapshot, type SignalSeries } from '../src/snapshot.ts';
import { compareSnapshots } from '../src/verify.ts';
import { TEST_DEFINITION, TEST_DEFINITION_SHA256 } from './definition-fixture.ts';

function scored(entityId: string, score: number): ScoredEntity {
  return {
    status: 'scored',
    entityId,
    day: '2026-11-16',
    value: 1000,
    baseline: 1000,
    baselineDays: 180,
    level: 1,
    score,
  };
}

function seriesFor(scores: readonly [string, number][]): SignalSeries {
  const entities = scores.map(([id, score]) => scored(id, score));
  const mean = entities.reduce((sum, entry) => sum + entry.score, 0) / entities.length;
  return {
    id: 'wikipedia-pageviews',
    label: 'Wikipedia pageviews',
    unit: 'views',
    scoring: TEST_DEFINITION.signals[0]?.scoring ?? ({} as SignalSeries['scoring']),
    index: {
      score: Math.round(mean * 100) / 100,
      scoredEntities: entities.length,
      totalEntities: entities.length,
    },
    momentum: null,
    entities,
  };
}

function snapshotWith(indexScore: number, scores: readonly [string, number][]): IndexSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: '2026-11-16',
    generatedAt: '2026-11-17T09:15:00.000Z',
    definitionId: TEST_DEFINITION.id,
    definition: TEST_DEFINITION,
    definitionSha256: TEST_DEFINITION_SHA256,
    index: { score: indexScore, scoredEntities: scores.length, totalEntities: scores.length },
    momentum: null,
    coverage: {
      signalsScored: 1,
      signalsTotal: 1,
      seriesScored: scores.length,
      seriesExpected: scores.length,
      coverageRatio: 1,
      weightScored: 1,
      oldestSourceAt: '2026-11-17T09:10:00.000Z',
    },
    series: [seriesFor(scores)],
    sources: [],
  };
}

test('an unchanged recompute reports no differences', () => {
  const published = snapshotWith(55, [
    ['nvidia', 60],
    ['openai', 50],
  ]);
  assert.deepEqual(compareSnapshots(published, snapshotWith(55, [
    ['nvidia', 60],
    ['openai', 50],
  ])), []);
});

test('a revised source shows up at entity, series and headline level', () => {
  const published = snapshotWith(55, [
    ['nvidia', 60],
    ['openai', 50],
  ]);
  const recomputed = snapshotWith(60, [
    ['nvidia', 70],
    ['openai', 50],
  ]);
  const differences = compareSnapshots(published, recomputed);
  assert.deepEqual(
    differences.map((entry) => entry.scope),
    ['headline', 'series:wikipedia-pageviews', 'entity:wikipedia-pageviews/nvidia'],
  );
  assert.deepEqual(differences[0], { scope: 'headline', published: 55, recomputed: 60 });
});

test('an entity that stopped scoring is reported as missing its score', () => {
  const published = snapshotWith(55, [
    ['nvidia', 60],
    ['openai', 50],
  ]);
  const recomputed = snapshotWith(60, [['nvidia', 60]]);
  const difference = compareSnapshots(published, recomputed).find(
    (entry) => entry.scope === 'entity:wikipedia-pageviews/openai',
  );
  assert.deepEqual(difference, {
    scope: 'entity:wikipedia-pageviews/openai',
    published: 50,
    recomputed: null,
  });
});

test('a definition whose recorded digest does not match its terms is reported', () => {
  const published = {
    ...snapshotWith(55, [['nvidia', 60]]),
    definitionSha256: 'c'.repeat(64),
  };
  const differences = compareSnapshots(published, snapshotWith(55, [['nvidia', 60]]));
  assert.equal(differences[0]?.scope, 'definition-digest');
});
