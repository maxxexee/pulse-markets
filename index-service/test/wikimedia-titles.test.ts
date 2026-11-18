import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GLOBAL_LANGUAGES,
  MIN_GLOBAL_LANGUAGES,
  TitleError,
  fetchTitles,
  sitelinksUrl,
  titlesFromSitelinks,
} from '../src/adapters/wikimedia-titles.ts';

const PAYLOAD = {
  entities: {
    Q182477: {
      sitelinks: {
        dewiki: { title: 'Nvidia' },
        frwiki: { title: 'Nvidia' },
        eswiki: { title: 'Nvidia' },
        jawiki: { title: 'エヌビディア' },
        ruwiki: { title: 'Nvidia' },
        zhwiki: { title: '英伟达' },
        itwiki: { title: 'Nvidia' },
      },
    },
  },
};

describe('sitelinksUrl', () => {
  it('asks Wikidata for the entity behind an English article', () => {
    const url = new URL(sitelinksUrl('Solana (blockchain platform)'));
    assert.equal(url.origin + url.pathname, 'https://www.wikidata.org/w/api.php');
    assert.equal(url.searchParams.get('sites'), 'enwiki');
    assert.equal(url.searchParams.get('titles'), 'Solana_(blockchain_platform)');
    assert.equal(url.searchParams.get('props'), 'sitelinks');
  });
});

describe('titlesFromSitelinks', () => {
  it('keeps the configured editions and their titles', () => {
    assert.deepEqual(titlesFromSitelinks(PAYLOAD), {
      de: 'Nvidia',
      fr: 'Nvidia',
      es: 'Nvidia',
      ja: 'エヌビディア',
      ru: 'Nvidia',
      zh: '英伟达',
    });
  });

  it('omits editions outside the requested list', () => {
    const titles = titlesFromSitelinks(PAYLOAD, ['de', 'fr', 'es', 'ja']);
    assert.deepEqual(Object.keys(titles), ['de', 'fr', 'es', 'ja']);
  });

  it('refuses a constituent that resolved too few editions', () => {
    assert.throws(
      () => titlesFromSitelinks(PAYLOAD, ['de', 'fr', 'es', 'ko', 'pt']),
      (error: unknown) => error instanceof TitleError && error.kind === 'no-sitelinks',
    );
  });

  it('names the threshold it applied', () => {
    const partial = {
      entities: { Q1: { sitelinks: { dewiki: { title: 'A' } } } },
    };
    assert.throws(() => titlesFromSitelinks(partial), new RegExp(`need ${MIN_GLOBAL_LANGUAGES}`));
  });

  it('rejects a payload with no entities', () => {
    assert.throws(
      () => titlesFromSitelinks({}),
      (error: unknown) => error instanceof TitleError && error.kind === 'malformed-response',
    );
  });

  it('rejects an entity with no sitelinks', () => {
    assert.throws(
      () => titlesFromSitelinks({ entities: { Q1: {} } }),
      (error: unknown) => error instanceof TitleError && error.kind === 'no-sitelinks',
    );
  });
});

describe('fetchTitles', () => {
  it('reads titles through the injected client', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(PAYLOAD));
    }) as typeof fetch;

    const titles = await fetchTitles('Nvidia', { fetchImpl });
    assert.equal(urls.length, 1);
    assert.equal(Object.keys(titles).length, GLOBAL_LANGUAGES.length);
  });

  it('wraps a client error as a title error', async () => {
    const fetchImpl = (async () => new Response('missing', { status: 404 })) as typeof fetch;
    await assert.rejects(
      fetchTitles('Nvidia', { fetchImpl }),
      (error: unknown) => error instanceof TitleError && error.kind === 'request-failed',
    );
  });
});
