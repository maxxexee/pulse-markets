import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { articleFromTitle, searchQuery } from '../src/adapters/wikipedia-search.ts';
import { fetchXTrends, XTrendsError } from '../src/adapters/x-trends.ts';
import { refreshDiscovery } from '../src/app/discovery.ts';
import { DISCOVERY_V1 } from '@pulse/index-core/discovery.ts';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('trends are parsed in rank order and incomplete rows are dropped', async () => {
  const result = await fetchXTrends({
    apiKey: 'key',
    fetchImpl: async () =>
      json({
        trends: [
          { trend: { name: 'Second', rank: 2 } },
          { trend: { name: 'First', rank: 1 } },
          { trend: { rank: 3 } },
          { trend: { name: '', rank: 4 } },
        ],
      }),
  });
  assert.deepEqual(result.trends, [
    { name: 'First', rank: 1 },
    { name: 'Second', rank: 2 },
  ]);
  assert.match(result.url, /woeid=1/);
});

test('a missing key is reported as not configured', async () => {
  await assert.rejects(
    () => fetchXTrends({ apiKey: '  ' }),
    (error: unknown) => error instanceof XTrendsError && error.kind === 'not-configured',
  );
});

test('query cleanup strips hashtags and punctuation', () => {
  assert.equal(searchQuery('#GTAVI'), 'GTAVI');
  assert.equal(searchQuery('  Grand Theft Auto VI!!! '), 'Grand Theft Auto VI');
  assert.equal(searchQuery('#'), '');
  assert.equal(articleFromTitle('Grand Theft Auto VI'), 'Grand_Theft_Auto_VI');
});

test('an X trend reaches discovery through search and pageview momentum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-x-'));
  const day = '2026-11-18';
  const days = [
    '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14',
    '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18',
  ];

  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.twitterapi.io') {
      return json({ trends: [{ trend: { name: '#GTAVI', rank: 1 } }] });
    }
    if (url.hostname === 'en.wikipedia.org' && url.pathname === '/w/api.php') {
      return json({ query: { search: [{ title: 'Grand Theft Auto VI' }] } });
    }
    if (url.pathname.includes('/pageviews/top/')) {
      return json({ items: [{ articles: [{ article: 'Nvidia', views: 500_000, rank: 1 }] }] });
    }
    if (url.pathname.includes('/pageviews/per-article/')) {
      return json({
        items: days.map((entry) => ({
          timestamp: `${entry.replaceAll('-', '')}00`,
          views: entry === day ? 5000 : 500,
        })),
      });
    }
    return new Response('{}', { status: 404 });
  };

  try {
    const record = await refreshDiscovery({
      day,
      basket: [
        { id: 'nvidia', label: 'Nvidia', wikipediaArticle: 'Nvidia', hackerNewsQuery: 'Nvidia' },
      ],
      snapshotsDir: dir,
      now: new Date(`${day}T12:00:00Z`),
      settings: {
        ...DISCOVERY_V1,
        minViews: 1000,
        minMomentum: 50,
        minBaselineViews: 100,
        maxResults: 3,
      },
      summary: null,
      xApiKey: 'key',
      fetchImpl: fakeFetch,
    });

    assert.deepEqual(
      record.entries.map((entry) => [entry.article, entry.via]),
      [['Grand_Theft_Auto_VI', 'x']],
    );
    assert.equal(record.entries[0]?.momentum, 900);

    const onDisk = JSON.parse(
      await readFile(join(dir, 'discovery', `${day}.json`), 'utf8'),
    ) as { entries: Array<{ via?: string }> };
    assert.equal(onDisk.entries[0]?.via, 'x');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
