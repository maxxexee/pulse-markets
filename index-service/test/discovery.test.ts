import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTopicArticle, parseTopArticles, WikipediaTopError } from '../src/adapters/wikipedia-top.ts';
import {
  DISCOVERY_V1,
  discoverTopics,
  selectCandidates,
  storyKey,
  topicLabel,
  type DiscoverySettings,
} from '@pulse/index-core/discovery.ts';

const settings: DiscoverySettings = {
  ...DISCOVERY_V1,
  minViews: 20_000,
  minMomentum: 100,
  maxResults: 3,
};

function series(values: number[], endDay = '2026-11-15'): Array<{ day: string; value: number }> {
  const end = new Date(`${endDay}T00:00:00Z`);
  return values.map((value, index) => {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - (values.length - 1 - index));
    return { day: day.toISOString().slice(0, 10), value };
  });
}

test('utility pages and namespaces are not topics', () => {
  assert.equal(isTopicArticle('Nvidia'), true);
  assert.equal(isTopicArticle('Main_Page'), false);
  assert.equal(isTopicArticle('Special:Search'), false);
  assert.equal(isTopicArticle('Wikipedia:Featured_pictures'), false);
  assert.equal(isTopicArticle(''), false);
});

test('the ranking is parsed in rank order with utility pages dropped', () => {
  const parsed = parseTopArticles({
    items: [
      {
        articles: [
          { article: 'Main_Page', views: 3_900_000, rank: 1 },
          { article: 'UFC_334', views: 321_149, rank: 2 },
          { article: 'Special:Search', views: 730_091, rank: 3 },
          { article: 'Josh_Hokit', views: 168_260, rank: 4 },
        ],
      },
    ],
  });
  assert.deepEqual(
    parsed.map((entry) => entry.article),
    ['UFC_334', 'Josh_Hokit'],
  );
});

test('a malformed ranking throws rather than returning an empty list', () => {
  assert.throws(() => parseTopArticles({ items: [] }), WikipediaTopError);
  assert.throws(() => parseTopArticles({ items: [{ articles: [{ article: 1 }] }] }), WikipediaTopError);
});

test('candidates are the biggest unclaimed articles, capped', () => {
  const picked = selectCandidates(
    [
      { article: 'Nvidia', views: 900, rank: 1 },
      { article: 'Small', views: 10, rank: 2 },
      { article: 'Big', views: 5000, rank: 3 },
      { article: 'Medium', views: 400, rank: 4 },
    ],
    new Set(['Nvidia']),
    2,
  );
  assert.deepEqual(picked, ['Big', 'Medium']);
});

test('standing list pages are kept out of discovery', () => {
  const picked = selectCandidates(
    [
      { article: 'List_of_Nazi_concentration_camps', views: 9000, rank: 1 },
      { article: 'Deaths_in_2026', views: 8000, rank: 2 },
      { article: 'UFC_334', views: 7000, rank: 3 },
    ],
    new Set(),
    3,
  );
  assert.deepEqual(picked, ['UFC_334']);
});

test('titles become readable topics', () => {
  assert.equal(topicLabel('List_of_highest-grossing_Indian_films'), 'List of highest-grossing Indian films');
});

test('a topic needs views, a baseline and the momentum threshold', () => {
  const found = discoverTopics(
    [
      // 25k views against a 1k baseline: 2400 percent, clears every bar.
      { article: 'Breakout', observations: series([1000, 1000, 1000, 25_000]) },
      // Below the view floor.
      { article: 'Quiet', observations: series([100, 100, 100, 5_000]) },
      // Real views, no real change.
      { article: 'Steady', observations: series([30_000, 30_000, 30_000, 30_000]) },
      // Too few baseline days to compare.
      { article: 'Fresh', observations: series([25_000]) },
    ],
    '2026-11-15',
    settings,
  );
  assert.deepEqual(
    found.map((entry) => entry.article),
    ['Breakout'],
  );
  const breakout = found[0];
  assert.equal(breakout?.momentum, 2400);
  assert.equal(breakout?.baseline, 1000);
  assert.equal(breakout?.baselineDays, 3);
  assert.equal(breakout?.views, 25_000);
});

test('results are ranked by momentum and capped', () => {
  const found = discoverTopics(
    [
      { article: 'Third', observations: series([1000, 1000, 1000, 40_000]) },
      { article: 'First', observations: series([1000, 1000, 1000, 120_000]) },
      { article: 'Second', observations: series([1000, 1000, 1000, 60_000]) },
      { article: 'Fourth', observations: series([1000, 1000, 1000, 30_000]) },
    ],
    '2026-11-15',
    { ...settings, maxResults: 3 },
  );
  assert.deepEqual(
    found.map((entry) => entry.article),
    ['First', 'Second', 'Third'],
  );
});

test('pages about one story share a key', () => {
  assert.equal(storyKey('Robert_Pattinson'), 'surname:pattinson');
  assert.equal(storyKey('Lizzy_Pattinson'), 'surname:pattinson');
  assert.equal(storyKey('Robert_Pattinson_filmography'), 'surname:pattinson');
  assert.equal(storyKey('Full_Gear_(2026)'), storyKey('Full_Gear_(2024)'));
  assert.equal(storyKey('Robert_Downey_Jr.'), storyKey('Robert_Downey'));
  assert.equal(storyKey('Robert_Downey_Jr._filmography'), storyKey('Robert_Downey'));
  assert.notEqual(storyKey('Robert_Downey_Jr.'), storyKey('John_Wayne_Jr.'));
  assert.notEqual(storyKey('Saturn_Devouring_His_Son'), storyKey('Saturn'));
});

test('one story gets one card, and keeps the most read page', () => {
  const found = discoverTopics(
    [
      { article: 'Robert_Pattinson', observations: series([1000, 1000, 1000, 90_000]) },
      { article: 'Robert_Pattinson_filmography', observations: series([1000, 1000, 1000, 60_000]) },
      { article: 'Lizzy_Pattinson', observations: series([1000, 1000, 1000, 40_000]) },
      { article: 'Saturn_Devouring_His_Son', observations: series([1000, 1000, 1000, 50_000]) },
    ],
    '2026-11-15',
    settings,
  );
  assert.deepEqual(
    found.map((entry) => entry.article),
    ['Robert_Pattinson', 'Saturn_Devouring_His_Son'],
  );
  assert.equal(found[0]?.alsoRanked?.length, 2);
  assert.deepEqual(found[1]?.alsoRanked, undefined);
});

test('a collapsed story frees a card for the next topic', () => {
  const found = discoverTopics(
    [
      { article: 'Robert_Pattinson', observations: series([1000, 1000, 1000, 90_000]) },
      { article: 'Robert_Pattinson_filmography', observations: series([1000, 1000, 1000, 60_000]) },
      { article: 'Saturn_Devouring_His_Son', observations: series([1000, 1000, 1000, 50_000]) },
      { article: 'Heidi_Gardner', observations: series([1000, 1000, 1000, 45_000]) },
    ],
    '2026-11-15',
    { ...settings, maxResults: 3 },
  );
  assert.deepEqual(
    found.map((entry) => entry.article),
    ['Robert_Pattinson', 'Saturn_Devouring_His_Son', 'Heidi_Gardner'],
  );
});

test('a baseline under the floor cannot produce a percentage', () => {
  const found = discoverTopics(
    [{ article: 'Tiny', observations: series([2, 2, 2, 100_000]) }],
    '2026-11-15',
    { ...settings, minBaselineViews: 100 },
  );
  assert.deepEqual(found, []);
});
