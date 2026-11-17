import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, fetchText } from '../src/adapters/http.ts';

const ok = (body: string): Response => new Response(body, { status: 200 });

function record(intervalMs: string): () => number {
  process.env['PULSE_REQUEST_INTERVAL_MS'] = intervalMs;
  return () => Number(process.env['PULSE_REQUEST_INTERVAL_MS']);
}

test('request starts are spaced by the configured interval', async () => {
  record('60');
  const starts: number[] = [];
  const fakeFetch = (async () => {
    starts.push(Date.now());
    return ok('{}');
  }) as unknown as typeof fetch;

  const began = Date.now();
  await Promise.all([fetchText('https://example.test/a', fakeFetch), fetchText('https://example.test/b', fakeFetch)]);
  const elapsed = Date.now() - began;

  assert.equal(starts.length, 2);
  const gap = (starts[1] ?? 0) - (starts[0] ?? 0);
  assert.ok(gap >= 55, `requests started ${gap}ms apart, expected at least 55`);
  assert.ok(elapsed < 2000, `pacing added ${elapsed}ms, expected well under a second`);
});

test('a client error other than 429 is raised without retrying', async () => {
  record('0');
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response('forbidden', { status: 403 });
  }) as unknown as typeof fetch;

  await assert.rejects(fetchText('https://example.test/forbidden', fakeFetch), (error: unknown) => {
    return error instanceof HttpError && error.status === 403;
  });
  assert.equal(calls, 1);
});

test('throttling is retried and can recover', async () => {
  record('0');
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return calls === 1 ? new Response('slow down', { status: 429 }) : ok('{"nbHits":1}');
  }) as unknown as typeof fetch;

  assert.equal(await fetchText('https://example.test/throttled', fakeFetch), '{"nbHits":1}');
  assert.equal(calls, 2);
});
