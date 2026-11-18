import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatConfig } from '../src/adapters/chat-completion.ts';
import { CONTEXT_PROMPT_VERSION, cleanNote, notesForTopics } from '../src/app/summaries.ts';
import type { DiscoveredTopic } from '../src/domain/discovery.ts';

const config: ChatConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://llm.test/v4',
  model: 'test-model',
};

const topic: DiscoveredTopic = {
  article: 'Robert_Pattinson',
  topic: 'Robert Pattinson',
  views: 1_363_657,
  baseline: 21_413,
  baselineDays: 7,
  momentum: 6268.2,
};

const article = {
  extract: 'Robert Douglas Thomas Pattinson is an English actor.',
  description: 'English actor',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Robert_Pattinson' } },
};

interface StubOptions {
  readonly extract?: unknown;
  readonly completion?: string;
  readonly status?: number;
}

function stubFetch(options: StubOptions): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/page/summary/')) {
      return new Response(JSON.stringify(options.extract));
    }
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    return new Response(
      JSON.stringify({ choices: [{ message: { content: options.completion ?? '' } }] }),
      { status: options.status ?? 200 },
    );
  };
  return { fetchImpl: fetchImpl as typeof fetch, bodies };
}

test('a note must be one number-free sentence', () => {
  assert.equal(
    cleanNote('  "English actor known for the Twilight films."  '),
    'English actor known for the Twilight films.',
  );
  assert.equal(cleanNote('He drew 1.3 million views.'), null);
  assert.equal(cleanNote('   '), null);
  assert.equal(cleanNote('word '.repeat(36)), null);
  assert.equal(cleanNote('word '.repeat(35).trim()), 'word '.repeat(35).trim());
});

test('a note is grounded in the article and records its provenance', async () => {
  const stub = stubFetch({
    extract: article,
    completion: 'English actor known for the Twilight films.',
  });
  const notes = await notesForTopics({ topics: [topic], day: '2026-11-16', config, fetchImpl: stub.fetchImpl });
  assert.deepEqual(notes.get('Robert_Pattinson'), {
    text: 'English actor known for the Twilight films.',
    model: 'test-model',
    promptVersion: CONTEXT_PROMPT_VERSION,
    sourceUrl: 'https://en.wikipedia.org/wiki/Robert_Pattinson',
  });
  assert.equal(stub.bodies.length, 1);
  const request = stub.bodies[0] ?? '';
  assert.match(request, /1363657 views against a 7 day average of 21413/);
  assert.match(request, /Robert Douglas Thomas Pattinson/);
  assert.match(request, /Never invent an event/);
});

test('a completion carrying a figure is dropped', async () => {
  const stub = stubFetch({ extract: article, completion: 'Views rose 6268 percent after a 2026 announcement.' });
  const notes = await notesForTopics({ topics: [topic], day: '2026-11-16', config, fetchImpl: stub.fetchImpl });
  assert.equal(notes.size, 0);
});

test('an unreadable article or a failed call leaves no note and does not throw', async () => {
  const missing = stubFetch({ extract: { title: 'Robert_Pattinson' } });
  assert.equal(
    (await notesForTopics({ topics: [topic], day: '2026-11-16', config, fetchImpl: missing.fetchImpl })).size,
    0,
  );

  const failed = stubFetch({ extract: article, status: 500 });
  assert.equal(
    (await notesForTopics({ topics: [topic], day: '2026-11-16', config, fetchImpl: failed.fetchImpl })).size,
    0,
  );
});
