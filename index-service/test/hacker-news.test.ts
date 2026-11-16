import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HackerNewsError,
  fetchMentions,
  mentionsUrl,
  parseMentionCount,
} from '../src/adapters/hacker-news.ts';

describe('mentionsUrl', () => {
  it('builds a count-only query for one UTC day', () => {
    const url = new URL(mentionsUrl('Jensen Huang', '2026-11-15'));
    assert.equal(url.origin + url.pathname, 'https://hn.algolia.com/api/v1/search');
    assert.equal(url.searchParams.get('query'), 'Jensen Huang');
    assert.equal(url.searchParams.get('tags'), 'story');
    assert.equal(url.searchParams.get('hitsPerPage'), '0');
    const start = Date.parse('2026-11-15T00:00:00Z') / 1000;
    assert.equal(
      url.searchParams.get('numericFilters'),
      `created_at_i>=${start},created_at_i<${start + 86_400}`,
    );
  });

  it('rejects an invalid day', () => {
    assert.throws(() => mentionsUrl('Nvidia', '15-11-2026'), HackerNewsError);
  });
});

describe('parseMentionCount', () => {
  it('reads nbHits from the response', () => {
    assert.equal(parseMentionCount({ nbHits: 17 }), 17);
  });

  it('rejects a response without a usable count', () => {
    assert.throws(
      () => parseMentionCount({ nbHits: '17' }),
      (error: unknown) =>
        error instanceof HackerNewsError && error.kind === 'malformed-response',
    );
  });

  it('rejects a negative count', () => {
    assert.throws(() => parseMentionCount({ nbHits: -1 }), HackerNewsError);
  });
});

describe('fetchMentions', () => {
  it('requests one URL per day and keeps them in order', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ nbHits: urls.length }));
    }) as typeof fetch;

    const fetched = await fetchMentions('Solana', '2026-11-13', '2026-11-15', { fetchImpl });
    assert.equal(fetched.urls.length, 3);
    assert.deepEqual(fetched.urls, urls);
    assert.deepEqual(fetched.observations, [
      { day: '2026-11-13', value: 1 },
      { day: '2026-11-14', value: 2 },
      { day: '2026-11-15', value: 3 },
    ]);
    assert.match(fetched.payloadSha256, /^[0-9a-f]{64}$/);
  });

  it('keeps day order when responses arrive out of order', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const filters = new URL(String(input)).searchParams.get('numericFilters') ?? '';
      const earliest = filters.includes(String(Date.parse('2026-11-13T00:00:00Z') / 1000));
      await new Promise((resolve) => setTimeout(resolve, earliest ? 20 : 0));
      return new Response(JSON.stringify({ nbHits: earliest ? 9 : 3 }));
    }) as typeof fetch;

    const fetched = await fetchMentions('Nvidia', '2026-11-13', '2026-11-15', {
      fetchImpl,
      concurrency: 3,
    });
    assert.deepEqual(fetched.observations, [
      { day: '2026-11-13', value: 9 },
      { day: '2026-11-14', value: 3 },
      { day: '2026-11-15', value: 3 },
    ]);
  });

  it('rejects a range longer than the day cap', async () => {
    await assert.rejects(
      fetchMentions('Solana', '2026-08-01', '2026-11-15'),
      /exceeds 62/,
    );
  });

  it('rejects a reversed range', async () => {
    await assert.rejects(fetchMentions('Solana', '2026-11-15', '2026-11-13'), /invalid range/);
  });
});
