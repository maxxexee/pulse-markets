import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchArticleImage } from '../src/adapters/wikipedia-top.ts';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('a summary thumbnail is returned without touching Wikidata', async () => {
  const seen: string[] = [];
  const image = await fetchArticleImage('Hunter_Schafer', {
    fetchImpl: async (input) => {
      seen.push(new URL(String(input)).hostname);
      return json({ thumbnail: { source: 'https://thumb.wikimedia.org/a.jpg?x=1' } });
    },
  });
  assert.equal(image, 'https://thumb.wikimedia.org/a.jpg');
  assert.deepEqual(seen, ['en.wikipedia.org']);
});

test('an article with no thumbnail falls back to the Wikidata image', async () => {
  const image = await fetchArticleImage('Some_Person', {
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/w/api.php') {
        return json({ query: { pages: [{ pageprops: { wikibase_item: 'Q123' } }] } });
      }
      if (url.hostname === 'www.wikidata.org') {
        return json({
          entities: { Q123: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Some Person.jpg' } } }] } } },
        });
      }
      return json({});
    },
  });
  assert.equal(
    image,
    'https://commons.wikimedia.org/wiki/Special:FilePath/Some_Person.jpg?width=330',
  );
});

test('no image anywhere returns null and never throws', async () => {
  const image = await fetchArticleImage('Manni_L._Perez', {
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/w/api.php') {
        return json({ query: { pages: [{ pageprops: { wikibase_item: 'Q125373422' } }] } });
      }
      if (url.hostname === 'www.wikidata.org') {
        return json({ entities: { Q125373422: { claims: {} } } });
      }
      return json({});
    },
  });
  assert.equal(image, null);
});
