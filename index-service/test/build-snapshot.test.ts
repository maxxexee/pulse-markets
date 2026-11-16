import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSnapshot } from '../src/app/build-snapshot.ts';
import type { EntityDefinition } from '../src/config/entities.ts';
import { addDays } from '../src/domain/dates.ts';
import type { DailyObservation } from '../src/domain/observation.ts';
import type { PageviewsFetch } from '../src/adapters/wikipedia-pageviews.ts';

const ENTITIES: readonly EntityDefinition[] = [
  { id: 'nvidia', label: 'Nvidia', wikipediaArticle: 'Nvidia' },
  { id: 'openai', label: 'OpenAI', wikipediaArticle: 'OpenAI' },
];

const TARGET = '2026-11-15';
const NOW = new Date('2026-11-16T00:10:00.000Z');
const SOURCE_HASH = 'a'.repeat(64);

/** Deterministic stand-in for the network, returning a flat history plus a spike. */
function fakeFetch(spikeViews: number) {
  const calls: Array<{ article: string; startDay: string; endDay: string }> = [];
  const fetchEntity = async (
    entity: EntityDefinition,
    startDay: string,
    endDay: string,
  ): Promise<PageviewsFetch> => {
    calls.push({ article: entity.wikipediaArticle, startDay, endDay });
    const observations: DailyObservation[] = [];
    for (let offset = 30; offset >= 1; offset -= 1) {
      observations.push({ day: addDays(TARGET, -offset), views: 100 });
    }
    observations.push({ day: TARGET, views: spikeViews });
    return {
      url: `https://example.test/${entity.wikipediaArticle}`,
      retrievedAt: NOW.toISOString(),
      payloadSha256: SOURCE_HASH,
      observations,
    };
  };
  return { calls, fetchEntity };
}

describe('buildSnapshot', () => {
  it('scores every entity and aggregates the index', async () => {
    const source = fakeFetch(200);
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      fetchEntity: source.fetchEntity,
      now: NOW,
    });
    assert.equal(snapshot.index.score, 62.5);
    assert.equal(snapshot.index.scoredEntities, 2);
    assert.equal(snapshot.epochDay, TARGET);
    assert.equal(snapshot.generatedAt, NOW.toISOString());
  });

  it('requests a range that includes the full baseline window and the target day', async () => {
    const source = fakeFetch(100);
    await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      fetchEntity: source.fetchEntity,
      now: NOW,
    });
    assert.equal(source.calls.length, 2);
    for (const call of source.calls) {
      assert.equal(call.endDay, TARGET);
      assert.equal(call.startDay, addDays(TARGET, -30));
    }
  });

  it('records provenance for every source it used', async () => {
    const source = fakeFetch(100);
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      fetchEntity: source.fetchEntity,
      now: NOW,
    });
    assert.equal(snapshot.sources.length, 2);
    const record = snapshot.sources[0];
    assert.ok(record);
    assert.equal(record.entityId, 'nvidia');
    assert.equal(record.payloadSha256, SOURCE_HASH);
    assert.equal(record.firstDay, addDays(TARGET, -30));
    assert.equal(record.lastDay, TARGET);
    assert.equal(record.observations, 31);
  });

  it('keeps an unscored entity in the snapshot instead of dropping it', async () => {
    const source = fakeFetch(100);
    const fetchEntity = async (
      entity: EntityDefinition,
      startDay: string,
      endDay: string,
    ): Promise<PageviewsFetch> => {
      const fetched = await source.fetchEntity(entity, startDay, endDay);
      if (entity.id !== 'openai') {
        return fetched;
      }
      return { ...fetched, observations: fetched.observations.slice(0, 2) };
    };
    const snapshot = await buildSnapshot({
      entities: ENTITIES,
      targetDay: TARGET,
      fetchEntity,
      now: NOW,
    });
    assert.equal(snapshot.index.scoredEntities, 1);
    assert.equal(snapshot.index.totalEntities, 2);
    const openai = snapshot.entities.find((entry) => entry.entityId === 'openai');
    assert.equal(openai?.status, 'insufficient-data');
  });
});
