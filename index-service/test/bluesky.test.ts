import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBlueskyTopics, parsePost } from '../src/adapters/bluesky.ts';
import { mentionsTopic } from '@pulse/index-core/social.ts';

function searchBody(posts: unknown[]): Response {
  return new Response(JSON.stringify({ posts }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function rawPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uri: 'at://did:plc:abc/app.bsky.feed.post/3n2udg7scw22y',
    author: { handle: 'edzitron.com', displayName: 'Ed Zitron' },
    record: {
      text: 'NVIDIA replaced Enron on November 28 2001',
      createdAt: '2026-11-22T00:10:00.000Z',
    },
    indexedAt: '2026-11-22T00:13:22.853Z',
    likeCount: 5874,
    repostCount: 1182,
    replyCount: 83,
    quoteCount: 27,
    ...overrides,
  };
}

test('a post becomes the same shape the panel already renders', () => {
  const post = parsePost(rawPost());
  assert.ok(post);
  assert.equal(post.id, 'at://did:plc:abc/app.bsky.feed.post/3n2udg7scw22y');
  assert.equal(post.author, 'edzitron.com');
  assert.equal(post.text, 'NVIDIA replaced Enron on November 28 2001');
  // The record's own time, not the AppView's indexing time, so a post is not
  // made to look newer than it is.
  assert.equal(post.createdAt, '2026-11-22T00:10:00.000Z');
  assert.equal(post.likes, 5874);
  // The protocol has no impressions, so this is unknown, never zero.
  assert.equal(post.views, null);
  assert.equal(post.source, 'bluesky');
  assert.equal(post.url, 'https://bsky.app/profile/edzitron.com/post/3n2udg7scw22y');
});

test('a post missing its author, time or text is dropped', () => {
  assert.equal(parsePost({}), null);
  assert.equal(parsePost(rawPost({ author: null })), null);
  assert.equal(parsePost(rawPost({ record: { text: '   ', createdAt: '2026-11-22T00:00:00Z' } })), null);
  assert.equal(parsePost(rawPost({ uri: null })), null);
  assert.equal(parsePost(rawPost({ indexedAt: null, record: { text: 'no time at all', createdAt: null } })), null);
  // The indexing time is a usable fallback when the record has none.
  const fallback = parsePost(rawPost({ record: { text: 'kept', createdAt: null } }));
  assert.equal(fallback?.createdAt, '2026-11-22T00:13:22.853Z');
});

test('a page keeps only posts that mention its topic, keyed the way the dashboard routes it', async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const q = new URL(String(input)).searchParams.get('q');
    if (q === 'Jensen Huang') {
      return searchBody([
        rawPost({ uri: 'at://d/app.bsky.feed.post/j1', record: { text: 'Jensen Huang on the roadmap', createdAt: '2026-11-22T00:00:00Z' } }),
        rawPost({ uri: 'at://d/app.bsky.feed.post/j2', record: { text: 'Elon Musk may buy Nvidia', createdAt: '2026-11-22T00:00:00Z' } }),
      ]);
    }
    return searchBody([
      rawPost({ uri: 'at://d/app.bsky.feed.post/f1', record: { text: 'Fiona the hippopotamus turns one', createdAt: '2026-11-22T00:00:00Z' } }),
      // Same word, different Fiona: the disambiguator has to be there too.
      rawPost({ uri: 'at://d/app.bsky.feed.post/f2', record: { text: 'Fiona sent the invoices over', createdAt: '2026-11-22T00:00:00Z' } }),
    ]);
  };
  const panels = await fetchBlueskyTopics(
    [
      { key: 'jensen-huang', label: 'Jensen Huang', query: '"Jensen Huang" lang:en' },
      { key: 'g:fiona-hippopotamus', label: 'Fiona (hippopotamus)', query: '"Fiona" lang:en' },
    ],
    { now: new Date(), fetchImpl: fakeFetch, delayMs: 0, retryMs: 0 },
  );
  assert.deepEqual(panels['jensen-huang']?.posts.map((p) => p.id), ['at://d/app.bsky.feed.post/j1']);
  // The disambiguation suffix is searched without, still keys the page, and is
  // required in the text so a different Fiona is not shown.
  assert.deepEqual(panels['g:fiona-hippopotamus']?.posts.map((p) => p.id), ['at://d/app.bsky.feed.post/f1']);
});

test('a refused page is retried once, logged, and left out without stopping the rest', async () => {
  let nvidiaCalls = 0;
  const lines: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const q = new URL(String(input)).searchParams.get('q');
    if (q === 'Nvidia') {
      nvidiaCalls += 1;
      return new Response('<html>403</html>', { status: 403 });
    }
    return searchBody([
      rawPost({ uri: 'at://d/app.bsky.feed.post/s1', record: { text: 'Solana fees are down', createdAt: '2026-11-22T00:00:00Z' } }),
    ]);
  };
  const panels = await fetchBlueskyTopics(
    [
      { key: 'nvidia', label: 'Nvidia', query: '"Nvidia" lang:en' },
      { key: 'solana', label: 'Solana', query: '"Solana" lang:en' },
    ],
    { now: new Date(), fetchImpl: fakeFetch, delayMs: 0, retryMs: 0, log: (line) => lines.push(line) },
  );
  assert.equal(nvidiaCalls, 2);
  assert.equal(panels['nvidia'], undefined);
  assert.equal(panels['solana']?.posts.length, 1);
  assert.ok(lines.some((line) => line.includes('nvidia') && line.includes('skipped')));
});

test('a label that is also an ordinary name needs its qualifying words', () => {
  const dog = "Meet 2 new additions to the Blazin' Drakes crew, Solana & Comet!";
  const crypto = 'Solana fees dropped again this week';
  // Without a co-term the dog is accepted; that was the bug the page shipped with.
  assert.equal(mentionsTopic(dog, 'Solana'), true);
  const requires = ['sol', 'blockchain', 'crypto', 'defi', 'wallet', 'token', 'chain', 'web3'];
  assert.equal(mentionsTopic(dog, 'Solana', requires), false);
  assert.equal(mentionsTopic(`${crypto} and the wallet is live`, 'Solana', requires), true);
  // "sol" must be its own word, not a piece of "solana".
  assert.equal(mentionsTopic('Solana is a word', 'Solana', ['sol']), false);
});

test('a page with no mention in any result is left out rather than shown empty', async () => {
  const fakeFetch: typeof fetch = async () =>
    searchBody([rawPost({ record: { text: 'unrelated chatter', createdAt: '2026-11-22T00:00:00Z' } })]);
  const panels = await fetchBlueskyTopics(
    [{ key: 'nvidia', label: 'Nvidia', query: '"Nvidia" lang:en' }],
    { now: new Date(), fetchImpl: fakeFetch, delayMs: 0, retryMs: 0 },
  );
  assert.deepEqual(panels, {});
});
