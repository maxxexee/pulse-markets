import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSocialPanel, SocialError } from '../src/adapters/twitter.ts';
import { summarizeSocial, type SocialPost } from '../src/domain/social.ts';
import { ENTITY_BASKET } from '../src/config/entities.ts';
import { socialQuery } from '../src/config/social.ts';

function page(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function tweet(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    createdAt: '2026-11-15T10:00:00.000Z',
    likeCount: 10,
    viewCount: 1000,
    author: { userName: 'someone' },
    ...overrides,
  };
}

test('the query names every basket entity once and excludes retweets', () => {
  const query = socialQuery(ENTITY_BASKET);
  for (const entity of ENTITY_BASKET) {
    assert.ok(query.includes(entity.label), entity.label);
  }
  assert.ok(query.includes('-filter:retweets'));
  assert.equal(query.split(' OR ').length, ENTITY_BASKET.length);
});

test('a panel is always weight zero and totals only known counts', () => {
  const posts: SocialPost[] = [
    { id: 'b', author: 'x', createdAt: '2026-11-15T09:00:00.000Z', likes: 2, views: null, url: 'u' },
    { id: 'a', author: 'y', createdAt: '2026-11-15T11:00:00.000Z', likes: 5, views: 40, url: 'u' },
  ];
  const panel = summarizeSocial({
    query: 'q',
    fetchedAt: '2026-11-15T12:00:00.000Z',
    posts,
    truncated: false,
  });
  assert.equal(panel.settlementWeight, 0);
  assert.deepEqual(panel.posts.map((post) => post.id), ['a', 'b']);
  assert.deepEqual(panel.totals, { posts: 2, likes: 7, views: 40 });
});

test('stops at the page budget and reports truncation', async () => {
  const cursors: (string | null)[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    cursors.push(url.searchParams.get('cursor'));
    const cursor = url.searchParams.get('cursor');
    const id = cursor === null ? 't1' : `t-${cursor}`;
    return page({ tweets: [tweet(id)], has_next_page: true, next_cursor: `c${cursors.length}` });
  };
  const panel = await fetchSocialPanel({
    apiKey: 'key',
    query: 'q',
    now: new Date('2026-11-15T12:00:00.000Z'),
    fetchImpl: fakeFetch,
    pageLimit: 2,
  });
  assert.equal(cursors.length, 2);
  assert.equal(cursors[0], null);
  assert.deepEqual(panel.posts.map((post) => post.id), ['t1', 't-c1']);
  assert.equal(panel.truncated, true);
  assert.equal(panel.fetchedAt, '2026-11-15T12:00:00.000Z');
});

test('stops when the source has no next page and derives the post url', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return page({
      tweets: [tweet('t1', { viewCount: null, author: { userName: 'alice' } })],
      has_next_page: false,
      next_cursor: '',
    });
  };
  const panel = await fetchSocialPanel({ apiKey: 'key', query: 'q', now: new Date(), fetchImpl: fakeFetch });
  assert.equal(calls, 1);
  assert.equal(panel.truncated, false);
  assert.equal(panel.posts[0]?.url, 'https://x.com/alice/status/t1');
  assert.equal(panel.posts[0]?.views, null);
});

test('skips unusable tweets and deduplicates ids across pages', async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const page2 = new URL(String(input)).searchParams.get('cursor') !== null;
    return page({
      tweets: page2
        ? [tweet('t1'), tweet('t2')]
        : [tweet('t1'), { nonsense: true }, tweet('')],
      has_next_page: true,
      next_cursor: 'next',
    });
  };
  const panel = await fetchSocialPanel({
    apiKey: 'key',
    query: 'q',
    now: new Date(),
    fetchImpl: fakeFetch,
    pageLimit: 2,
  });
  assert.deepEqual(panel.posts.map((post) => post.id), ['t1', 't2']);
});

test('a missing key is reported as not configured, never as an empty panel', async () => {
  await assert.rejects(
    fetchSocialPanel({ apiKey: '  ', query: 'q', now: new Date() }),
    (error: unknown) => error instanceof SocialError && error.kind === 'not-configured',
  );
});

test('an HTTP error or a malformed body fails instead of publishing', async () => {
  await assert.rejects(
    fetchSocialPanel({
      apiKey: 'key',
      query: 'q',
      now: new Date(),
      fetchImpl: async () => new Response('{}', { status: 401 }),
    }),
    (error: unknown) => error instanceof SocialError && error.kind === 'request-failed',
  );
  await assert.rejects(
    fetchSocialPanel({
      apiKey: 'key',
      query: 'q',
      now: new Date(),
      fetchImpl: async () => page({ tweets: 'none' }),
    }),
    (error: unknown) => error instanceof SocialError && error.kind === 'malformed',
  );
});
