import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageSearchKey, searchTopicImage } from '../src/adapters/image-search.ts';
import { resolveTopicImage } from '../src/app/topic-image.ts';
import type { DiscoveredTopic } from '@pulse/index-core/discovery.ts';

const topic: DiscoveredTopic = {
  article: 'Manni_L._Perez',
  topic: 'Manni L. Perez',
  views: 1000,
  baseline: 68,
  baselineDays: 7,
  momentum: 1370.2,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('a key is read from the environment and an empty value disables search', () => {
  assert.equal(imageSearchKey({ SERPER_API_KEY: 'abc' }), 'abc');
  assert.equal(imageSearchKey({ SERPER_API_KEY: '  ' }), null);
  assert.equal(imageSearchKey({}), null);
});

test('the first wide enough https result is returned with its page', async () => {
  const image = await searchTopicImage('Manni L. Perez', {
    apiKey: 'abc',
    fetchImpl: async () =>
      json({
        images: [
          { imageUrl: 'https://cdn.example.com/small.jpg', imageWidth: 120 },
          { imageUrl: 'https://cdn.example.com/face.webp', imageWidth: 800, link: 'https://example.com/a' },
        ],
      }),
  });
  assert.deepEqual(image, {
    imageUrl: 'https://cdn.example.com/face.webp',
    sourceUrl: 'https://example.com/a',
  });
});

test('results the cards cannot paint are skipped', async () => {
  const image = await searchTopicImage('Someone', {
    apiKey: 'abc',
    fetchImpl: async () =>
      json({
        images: [
          { imageUrl: 'http://insecure.example.com/a.jpg', imageWidth: 900 },
          { imageUrl: 'https://cdn.example.com/logo.svg', imageWidth: 900 },
          { imageUrl: 'https://cdn.example.com/ok.jpg', imageWidth: 900 },
        ],
      }),
  });
  assert.equal(image?.imageUrl, 'https://cdn.example.com/ok.jpg');
});

test('a topic with no article image is filled from the image search', async () => {
  const image = await resolveTopicImage(topic, {
    searchKey: 'abc',
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'google.serper.dev') {
        return json({
          images: [
            { imageUrl: 'https://cdn.example.com/manni.jpg', imageWidth: 900, link: 'https://example.com/manni' },
          ],
        });
      }
      if (url.pathname === '/w/api.php') return json({ query: { pages: [{ pageprops: {} }] } });
      return json({});
    },
  });
  assert.deepEqual(image, {
    url: 'https://cdn.example.com/manni.jpg',
    source: 'https://example.com/manni',
  });
});

test('without a key the search is never called and the card keeps its fallback', async () => {
  const hosts: string[] = [];
  const image = await resolveTopicImage(topic, {
    searchKey: null,
    fetchImpl: async (input) => {
      hosts.push(new URL(String(input)).hostname);
      if (new URL(String(input)).pathname === '/w/api.php') {
        return json({ query: { pages: [{ pageprops: {} }] } });
      }
      return json({});
    },
  });
  assert.deepEqual(image, { url: null, source: null });
  assert.equal(hosts.includes('google.serper.dev'), false);
});

test('a rejected request or nothing usable returns null', async () => {
  const rejected = await searchTopicImage('Someone', {
    apiKey: 'abc',
    fetchImpl: async () => json({ message: 'bad key' }, 403),
  });
  assert.equal(rejected, null);
  const empty = await searchTopicImage('Someone', {
    apiKey: 'abc',
    fetchImpl: async () => json({ images: [] }),
  });
  assert.equal(empty, null);
  const failed = await searchTopicImage('Someone', {
    apiKey: 'abc',
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(failed, null);
});
