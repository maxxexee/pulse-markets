import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchGlobalPageviews } from '../src/adapters/wikipedia-global.ts';
import { WikipediaError } from '../src/adapters/wikipedia-pageviews.ts';

const TITLES = { de: 'Nvidia', fr: 'Nvidia', ja: 'エヌビディア' };

/** Answers each edition with a fixed daily series, keyed by project. */
function fakeEditions(views: Record<string, Record<string, number>>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const project = new URL(url).pathname.split('/')[6] ?? '';
    const language = project.split('.')[0] ?? '';
    const items = Object.entries(views[language] ?? {}).map(([day, value]) => ({
      timestamp: `${day.replaceAll('-', '')}00`,
      views: value,
    }));
    return new Response(JSON.stringify({ items }));
  }) as typeof fetch;
  return { urls, fetchImpl };
}

describe('fetchGlobalPageviews', () => {
  it('sums the same day across editions', async () => {
    const { fetchImpl } = fakeEditions({
      de: { '2026-11-15': 10, '2026-11-16': 4 },
      fr: { '2026-11-15': 5 },
      ja: { '2026-11-16': 6 },
    });
    const fetched = await fetchGlobalPageviews(TITLES, '2026-11-15', '2026-11-16', { fetchImpl });
    assert.deepEqual(fetched.observations, [
      { day: '2026-11-15', value: 15 },
      { day: '2026-11-16', value: 10 },
    ]);
  });

  it('records one URL per edition in language order', async () => {
    const { fetchImpl } = fakeEditions({ de: {}, fr: {}, ja: {} });
    const fetched = await fetchGlobalPageviews(TITLES, '2026-11-15', '2026-11-15', { fetchImpl });
    assert.equal(fetched.urls.length, 3);
    assert.match(fetched.urls[0] ?? '', /\/de\.wikipedia\//);
    assert.match(fetched.urls[1] ?? '', /\/fr\.wikipedia\//);
    assert.match(fetched.urls[2] ?? '', /\/ja\.wikipedia\//);
  });

  it('publishes a hash over the response bodies', async () => {
    const { fetchImpl } = fakeEditions({ de: {}, fr: {}, ja: {} });
    const fetched = await fetchGlobalPageviews(TITLES, '2026-11-15', '2026-11-15', { fetchImpl });
    assert.match(fetched.payloadSha256, /^[0-9a-f]{64}$/);
  });

  it('refuses to read without frozen titles', async () => {
    await assert.rejects(
      fetchGlobalPageviews({}, '2026-11-15', '2026-11-15'),
      (error: unknown) => error instanceof WikipediaError && error.kind === 'request-failed',
    );
  });

  it('names the edition that failed', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes('/fr.wikipedia/')
        ? new Response('gone', { status: 404 })
        : new Response(JSON.stringify({ items: [] }));
    }) as typeof fetch;
    await assert.rejects(
      fetchGlobalPageviews(TITLES, '2026-11-15', '2026-11-15', { fetchImpl }),
      /fr:/,
    );
  });
});
