import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildTrends, momentumFor, statusFor, trendsPayload } from '../src/app/trends.ts';
import { ENTITY_BASKET } from '../src/config/entities.ts';
import { SNAPSHOT_SCHEMA, type IndexSnapshot, type SignalSeries } from '../src/domain/snapshot.ts';
import { PULSE_SCORING_V1, type EntityScore } from '../src/domain/scoring.ts';

function score(entityId: string, level: number, value = 1000): EntityScore {
  return {
    status: 'scored',
    entityId,
    day: '2026-11-15',
    value,
    baseline: Math.round(value / level),
    baselineDays: 30,
    level,
    score: 50,
  };
}

function unscored(entityId: string): EntityScore {
  return {
    status: 'insufficient-data',
    entityId,
    day: '2026-11-15',
    value: null,
    baselineDays: 3,
    reason: 'too-few-baseline-days',
  };
}

function series(id: string, entities: EntityScore[]): SignalSeries {
  return {
    id,
    label: id,
    unit: 'count',
    scoring: PULSE_SCORING_V1,
    index: { score: 50, scoredEntities: entities.length, totalEntities: entities.length },
    momentum: null,
    entities,
  };
}

function snapshot(epochDay: string, seriesList: SignalSeries[]): IndexSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay,
    generatedAt: `${epochDay}T00:00:00.000Z`,
    definitionId: 'pulse-attention-v4',
    index: { score: 50, scoredEntities: 1, totalEntities: 1 },
    momentum: null,
    coverage: {
      signalsScored: seriesList.length,
      signalsTotal: seriesList.length,
      seriesScored: 1,
      seriesExpected: 1,
      confidence: 1,
      oldestSourceAt: null,
    },
    series: seriesList,
    sources: [],
  };
}

const basket = ENTITY_BASKET.filter((entity) => ['openai', 'nvidia', 'solana'].includes(entity.id));

test('momentum is the percent change in level against the reference epoch', () => {
  const now = snapshot('2026-11-15', [series('wikipedia-pageviews', [score('nvidia', 2)])]);
  const before = snapshot('2026-11-08', [series('wikipedia-pageviews', [score('nvidia', 1)])]);
  assert.equal(momentumFor('nvidia', now, before), 100);
});

test('momentum averages the signals that can be compared', () => {
  const now = snapshot('2026-11-15', [
    series('wikipedia-pageviews', [score('nvidia', 3)]),
    series('hacker-news-stories', [score('nvidia', 1)]),
  ]);
  const before = snapshot('2026-11-08', [
    series('wikipedia-pageviews', [score('nvidia', 1)]),
    series('hacker-news-stories', [score('nvidia', 1)]),
  ]);
  // +200 percent on pageviews, flat on mentions: averaged, not summed.
  assert.equal(momentumFor('nvidia', now, before), 100);
});

test('a signal missing from the reference does not count as no change', () => {
  const now = snapshot('2026-11-15', [
    series('wikipedia-pageviews', [score('nvidia', 3)]),
    series('hacker-news-stories', [score('nvidia', 2)]),
  ]);
  const before = snapshot('2026-11-08', [series('wikipedia-pageviews', [score('nvidia', 1)])]);
  assert.equal(momentumFor('nvidia', now, before), 200);
});

test('momentum is null when there is nothing to compare', () => {
  const now = snapshot('2026-11-15', [series('wikipedia-pageviews', [score('nvidia', 2)])]);
  assert.equal(momentumFor('nvidia', now, null), null);
  const before = snapshot('2026-11-08', [series('wikipedia-pageviews', [score('nvidia', 2)])]);
  assert.equal(momentumFor('openai', now, before), null);
});

test('status bands are coarse and inclusive at the lower edge', () => {
  assert.equal(statusFor(10), 'surging');
  assert.equal(statusFor(9.9), 'trending');
  assert.equal(statusFor(2), 'trending');
  assert.equal(statusFor(1.9), 'stable');
  assert.equal(statusFor(-1.9), 'stable');
  assert.equal(statusFor(-2), 'fading');
  assert.equal(statusFor(null), 'stable');
});

test('one trend per measurable entity, with a link per signal', () => {
  const now = snapshot('2026-11-15', [
    series('wikipedia-pageviews', [score('openai', 2), score('nvidia', 1), unscored('solana')]),
    series('hacker-news-stories', [score('nvidia', 1, 12)]),
  ]);
  const trends = buildTrends(now, null, basket);
  // Basket order, since neither trend has a measured momentum to sort on.
  assert.deepEqual(
    trends.map((trend) => trend.id),
    ['nvidia', 'openai'],
  );
  const nvidia = trends[0];
  assert.equal(nvidia?.sourceCount, 2);
  assert.deepEqual(
    nvidia?.sources.map((source) => source.source),
    ['wikipedia', 'hackernews'],
  );
  assert.equal(nvidia?.sources[0]?.volume, 1000);
  assert.equal(nvidia?.sources[1]?.volume, 12);
  assert.match(nvidia?.sources[0]?.link ?? '', /en\.wikipedia\.org\/wiki\/Nvidia/);
  assert.match(nvidia?.sources[1]?.link ?? '', /hn\.algolia\.com/);
});

test('an entity with no scored signal is left out rather than shown as flat', () => {
  const now = snapshot('2026-11-15', [series('wikipedia-pageviews', [unscored('solana')])]);
  assert.deepEqual(buildTrends(now, null, basket), []);
});

test('cards are ordered by momentum, with unmeasured trends last', () => {
  const now = snapshot('2026-11-15', [
    series('wikipedia-pageviews', [score('openai', 1.1), score('nvidia', 2), score('solana', 3)]),
  ]);
  const before = snapshot('2026-11-08', [
    series('wikipedia-pageviews', [score('openai', 1), score('nvidia', 2), score('solana', 1)]),
  ]);
  assert.deepEqual(
    buildTrends(now, before, basket).map((trend) => trend.id),
    ['solana', 'openai', 'nvidia'],
  );
  assert.equal(buildTrends(now, null, basket)[0]?.momentum, null);
});

test('discovered topics follow the basket in the payload, flagged as discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-trends-'));
  try {
    const current = snapshot('2026-11-15', [series('wikipedia-pageviews', [score('openai', 2)])]);
    await writeFile(join(dir, 'latest.json'), JSON.stringify({ snapshot: current }));
    await mkdir(join(dir, 'discovery'), { recursive: true });
    await writeFile(
      join(dir, 'discovery', '2026-11-15.json'),
      JSON.stringify({
        day: '2026-11-15',
        generatedAt: '2026-11-16T00:00:00.000Z',
        method: 'wikipedia-top-v1',
        settings: { minViews: 20000, minMomentum: 100 },
        entries: [
          {
            article: 'UFC_334',
            topic: 'UFC 334',
            views: 321149,
            baseline: 23761,
            baselineDays: 7,
            momentum: 1251.6,
            link: 'https://en.wikipedia.org/wiki/UFC_334',
            imageUrl: null,
          },
        ],
      }),
    );

    const payload = JSON.parse(await trendsPayload({ snapshotsDir: dir, basket })) as {
      trends: Array<Record<string, unknown>>;
      discovery: { day: string; minMomentum: number } | null;
    };
    assert.equal(payload.trends.length, 2);
    const discovered = payload.trends[1];
    assert.equal(discovered?.id, 'wiki:UFC_334');
    assert.equal(discovered?.topic, 'UFC 334');
    assert.equal(discovered?.discovered, true);
    assert.equal(discovered?.status, 'surging');
    assert.equal(discovered?.imageUrl, undefined);
    assert.deepEqual(discovered?.sources, [
      {
        source: 'wikipedia',
        volume: 321149,
        link: 'https://en.wikipedia.org/wiki/UFC_334',
      },
    ]);
    assert.deepEqual(payload.discovery, {
      day: '2026-11-15',
      method: 'wikipedia-top-v1',
      minViews: 20000,
      minMomentum: 100,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a day with no discovery record still serves the basket trends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-trends-'));
  try {
    const current = snapshot('2026-11-15', [series('wikipedia-pageviews', [score('openai', 2)])]);
    await writeFile(join(dir, 'latest.json'), JSON.stringify({ snapshot: current }));
    const payload = JSON.parse(await trendsPayload({ snapshotsDir: dir, basket })) as {
      trends: unknown[];
      discovery: unknown;
    };
    assert.equal(payload.trends.length, 1);
    assert.equal(payload.discovery, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every basket entity in this test carries an image', () => {
  const now = snapshot('2026-11-15', [
    series('wikipedia-pageviews', [score('openai', 2), score('nvidia', 2), score('solana', 2)]),
  ]);
  const byId = new Map(buildTrends(now, null, basket).map((trend) => [trend.id, trend]));
  assert.equal(byId.get('openai')?.imageUrl, 'openai.webp');
  assert.equal(byId.get('solana')?.imageUrl, 'solana.webp');
  assert.match(byId.get('nvidia')?.imageUrl ?? '', /wikimedia\.org/);
});
