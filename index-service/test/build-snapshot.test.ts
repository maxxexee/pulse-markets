import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSnapshot } from '../src/app/build-snapshot.ts';
import type { EntityDefinition } from '../src/config/entities.ts';
import type { SeriesFetch, SignalDefinition } from '../src/config/signals.ts';
import { addDays } from '../src/domain/dates.ts';
import type { DailyObservation } from '../src/domain/observation.ts';
import { PULSE_SCORING_V1 } from '../src/domain/scoring.ts';

const ENTITIES: readonly EntityDefinition[] = [
  { id: 'nvidia', label: 'Nvidia', wikipediaArticle: 'Nvidia', hackerNewsQuery: 'Nvidia' },
  { id: 'openai', label: 'OpenAI', wikipediaArticle: 'OpenAI', hackerNewsQuery: 'OpenAI' },
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
});
