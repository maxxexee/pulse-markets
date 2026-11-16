import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSnapshot } from '../src/app/build-snapshot.ts';
import type { EntityDefinition } from '../src/config/entities.ts';
import { INDEX_DEFINITION_ID } from '../src/config/index-definition.ts';
import type { SeriesFetch, SignalDefinition } from '../src/config/signals.ts';
import { addDays } from '../src/domain/dates.ts';
import { MOMENTUM_WINDOW_DAYS } from '../src/domain/momentum.ts';
import type { DailyObservation } from '../src/domain/observation.ts';
import { PULSE_SCORING_V1 } from '../src/domain/scoring.ts';
import { SNAPSHOT_SCHEMA, type IndexSnapshot } from '../src/domain/snapshot.ts';

const ENTITIES: readonly EntityDefinition[] = [
  {
    id: 'nvidia',
    label: 'Nvidia',
    wikipediaArticle: 'Nvidia',
    hackerNewsQuery: 'Nvidia',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wikipediaArticle: 'OpenAI',
    hackerNewsQuery: 'OpenAI',
  },
];

const TARGET = '2026-11-15';
const NOW = new Date('2026-11-16T00:10:00.000Z');
const SOURCE_HASH = 'a'.repeat(64);

/** Deterministic stand-in for the network, returning a flat history plus a spike. */
function fakeSignal(id: string, spike: number) {
  const calls: Array<{ entityId: string; startDay: string; endDay: string }> = [];
  const fetchSeries = async (
    entity: EntityDefinition,
    startDay: string,
    endDay: string,
  ): Promise<SeriesFetch> => {
    calls.push({ entityId: entity.id, startDay, endDay });
    const observations: DailyObservation[] = [];
    for (let offset = 30; offset >= 1; offset -= 1) {
      observations.push({ day: addDays(TARGET, -offset), value: 100 });
    }
    observations.push({ day: TARGET, value: spike });
    return {
      urls: [`https://example.test/${id}/${entity.id}`],
      retrievedAt: NOW.toISOString(),
      payloadSha256: SOURCE_HASH,
      observations,
    };
  };
  const signal: SignalDefinition = {
    id,
    label: id,
    unit: 'units',
    scoring: PULSE_SCORING_V1,
    fetchSeries,
  };
  return { calls, signal };
}

function twoSignals(spike: number) {
  const pageviews = fakeSignal('wikipedia-pageviews', spike);
  const mentions = fakeSignal('hacker-news-stories', spike);
  return { pageviews, mentions, signals: [pageviews.signal, mentions.signal] };
}

describe('buildSnapshot', () => {
  it('scores every entity in every signal and combines the index', async () => {
    const { signals } = twoSignals(200);
    const snapshot = await buildSnapshot({ entities: ENTITIES, targetDay: TARGET, signals, now: NOW });
    assert.equal(snapshot.index.score, 62.5);
    assert.equal(snapshot.series.length, 2);
    for (const series of snapshot.series) {
      assert.equal(series.index.score, 62.5);
      assert.equal(series.index.scoredEntities, 2);
    }
    assert.equal(snapshot.epochDay, TARGET);
    assert.equal(snapshot.generatedAt, NOW.toISOString());
  });

  it('requests a range covering the full baseline window and the target day', async () => {
    const { pageviews, mentions, signals } = twoSignals(100);
    await buildSnapshot({ entities: ENTITIES, targetDay: TARGET, signals, now: NOW });
    assert.equal(pageviews.calls.length, 2);
    assert.equal(mentions.calls.length, 2);
    for (const call of [...pageviews.calls, ...mentions.calls]) {
      assert.equal(call.endDay, TARGET);
      assert.equal(call.startDay, addDays(TARGET, -30));
    }
  });

  it('records provenance for every entity in every signal', async () => {
    const { signals } = twoSignals(100);
    const snapshot = await buildSnapshot({ entities: ENTITIES, targetDay: TARGET, signals, now: NOW });
    assert.equal(snapshot.sources.length, 4);
    const record = snapshot.sources[0];
    assert.ok(record);
    assert.equal(record.entityId, 'nvidia');
    assert.equal(record.signal, 'wikipedia-pageviews');
    assert.deepEqual(record.urls, ['https://example.test/wikipedia-pageviews/nvidia']);
    assert.equal(record.payloadSha256, SOURCE_HASH);
    assert.equal(record.firstDay, addDays(TARGET, -30));
    assert.equal(record.lastDay, TARGET);
    assert.equal(record.observations, 31);
  });

  it('keeps an unscored entity in the snapshot instead of dropping it', async () => {
    const { pageviews, signals } = twoSignals(100);
    const fetchSeries = pageviews.signal.fetchSeries;
    const signalsWithGap: SignalDefinition[] = [
      {
        ...pageviews.signal,
        fetchSeries: async (entity, startDay, endDay) => {
          const fetched = await fetchSeries(entity, startDay, endDay);
          if (entity.id !== 'openai') {
            return fetched;
          }
          return { ...fetched, observations: fetched.observations.slice(0, 2) };
        },
      },
    ];
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      signals: signalsWithGap,
      now: NOW,
    });
    const series = snapshot.series[0];
    assert.ok(series);
    assert.equal(series.index.scoredEntities, 1);
    assert.equal(series.index.totalEntities, 2);
    const openai = series.entities.find((entry) => entry.entityId === 'openai');
    assert.equal(openai?.status, 'insufficient-data');
  });

  it('keeps series and source order when fetches finish out of order', async () => {
    const { signals } = twoSignals(150);
    const outOfOrder = signals.map((signal) => ({
      ...signal,
      fetchSeries: async (entity: EntityDefinition, startDay: string, endDay: string) => {
        const position = ENTITIES.findIndex((entry) => entry.id === entity.id);
        await new Promise((resolve) => setTimeout(resolve, (2 - position) * 10));
        return signal.fetchSeries(entity, startDay, endDay);
      },
    }));
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      signals: outOfOrder,
      now: NOW,
      concurrency: 4,
    });
    assert.deepEqual(
      snapshot.series.map((entry) => entry.id),
      ['wikipedia-pageviews', 'hacker-news-stories'],
    );
    assert.deepEqual(
      snapshot.series[0]?.entities.map((entry) => entry.entityId),
      ['nvidia', 'openai'],
    );
    assert.deepEqual(
      snapshot.sources.map((record) => `${record.signal}/${record.entityId}`),
      [
        'wikipedia-pageviews/nvidia',
        'wikipedia-pageviews/openai',
        'hacker-news-stories/nvidia',
        'hacker-news-stories/openai',
      ],
    );
  });

  it('keeps a signal that scored nothing out of the headline mean', async () => {
    const { pageviews, signals } = twoSignals(200);
    const silent: SignalDefinition = {
      ...pageviews.signal,
      id: 'silent',
      fetchSeries: async () => ({
        urls: ['https://example.test/silent'],
        retrievedAt: NOW.toISOString(),
        payloadSha256: SOURCE_HASH,
        observations: [],
      }),
    };
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      signals: [...signals, silent],
      now: NOW,
    });
    assert.equal(snapshot.series.length, 3);
    assert.equal(snapshot.series[2]?.index.score, null);
    assert.equal(snapshot.index.score, 62.5);
  });

  it('names the published definition and reports coverage beside the score', async () => {
    const { signals } = twoSignals(200);
    const snapshot = await buildSnapshot({ entities: ENTITIES, targetDay: TARGET, signals, now: NOW });
    assert.equal(snapshot.definitionId, INDEX_DEFINITION_ID);
    assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);
    assert.deepEqual(
      {
        signalsScored: snapshot.coverage.signalsScored,
        signalsTotal: snapshot.coverage.signalsTotal,
        seriesScored: snapshot.coverage.seriesScored,
        seriesExpected: snapshot.coverage.seriesExpected,
        confidence: snapshot.coverage.confidence,
      },
      { signalsScored: 2, signalsTotal: 2, seriesScored: 4, seriesExpected: 4, confidence: 1 },
    );
    assert.equal(snapshot.coverage.oldestSourceAt, NOW.toISOString());
  });

  it('halves confidence when half the series cannot be scored', async () => {
    const { pageviews } = twoSignals(100);
    const fetchSeries = pageviews.signal.fetchSeries;
    const oneScored: SignalDefinition = {
      ...pageviews.signal,
      fetchSeries: async (entity, startDay, endDay) => {
        const fetched = await fetchSeries(entity, startDay, endDay);
        return entity.id === 'openai'
          ? { ...fetched, observations: fetched.observations.slice(0, 2) }
          : fetched;
      },
    };
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      signals: [oneScored],
      now: NOW,
    });
    assert.equal(snapshot.coverage.seriesScored, 1);
    assert.equal(snapshot.coverage.seriesExpected, 2);
    assert.equal(snapshot.coverage.confidence, 0.5);
  });

  it('publishes null momentum when no reference snapshot was published', async () => {
    const { signals } = twoSignals(200);
    const snapshot = await buildSnapshot({ entities: ENTITIES, targetDay: TARGET, signals, now: NOW });
    assert.equal(snapshot.momentum, null);
    for (const series of snapshot.series) {
      assert.equal(series.momentum, null);
    }
  });

  it('measures momentum against the snapshot seven days earlier', async () => {
    const { signals } = twoSignals(200);
    const referenceDay = addDays(TARGET, -MOMENTUM_WINDOW_DAYS);
    const reference = priorSnapshot(referenceDay, 40, {
      'wikipedia-pageviews': 60,
      'hacker-news-stories': 30,
    });
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      signals,
      now: NOW,
      history: [reference],
    });
    assert.deepEqual(snapshot.momentum, {
      windowDays: MOMENTUM_WINDOW_DAYS,
      referenceDay,
      delta: 22.5,
      score: 72.5,
    });
    assert.equal(snapshot.series[0]?.momentum?.delta, 2.5);
    assert.equal(snapshot.series[1]?.momentum?.delta, 32.5);
  });

  it('ignores a reference snapshot for a different day', async () => {
    const { signals } = twoSignals(200);
    const reference = priorSnapshot(addDays(TARGET, -6), 10, {});
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      signals,
      now: NOW,
      history: [reference],
    });
    assert.equal(snapshot.momentum, null);
  });
});

/** Minimal published snapshot used only to derive momentum in these tests. */
function priorSnapshot(
  epochDay: string,
  indexScore: number,
  seriesScores: Record<string, number>,
): IndexSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay,
    generatedAt: `${epochDay}T00:10:00.000Z`,
    definitionId: INDEX_DEFINITION_ID,
    index: { score: indexScore, scoredEntities: 2, totalEntities: 2 },
    momentum: null,
    coverage: {
      signalsScored: 0,
      signalsTotal: 0,
      seriesScored: 0,
      seriesExpected: 0,
      confidence: 0,
      oldestSourceAt: null,
    },
    series: Object.entries(seriesScores).map(([id, score]) => ({
      id,
      label: id,
      unit: 'units',
      scoring: PULSE_SCORING_V1,
      index: { score, scoredEntities: 2, totalEntities: 2 },
      momentum: null,
      entities: [],
    })),
    sources: [],
  };
}
