import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GdeltError,
  fetchArticles,
  gdeltUrl,
  parseTimeline,
} from '../src/adapters/gdelt.ts';

const START = '2026-11-13';
const END = '2026-11-15';

function timeline(points: Array<{ date: string; value: number }>) {
  return { timeline: [{ series: 'Article Count', data: points }] };
}

describe('gdeltUrl', () => {
  it('asks for a quoted phrase over one day range', () => {
    const url = new URL(gdeltUrl('Jensen Huang', START, END));
    assert.equal(url.origin + url.pathname, 'https://api.gdeltproject.org/api/v2/doc/doc');
    assert.equal(url.searchParams.get('query'), '"Jensen Huang"');
    assert.equal(url.searchParams.get('mode'), 'timelinevolraw');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('startdatetime'), '20261113000000');
    assert.equal(url.searchParams.get('enddatetime'), '20261115235959');
  });

  it('rejects an invalid or reversed range', () => {
    assert.throws(() => gdeltUrl('Nvidia', '13-11-2026', END), GdeltError);
    assert.throws(() => gdeltUrl('Nvidia', END, START), GdeltError);
  });
});

describe('parseTimeline', () => {
  it('returns one observation per day in order', () => {
    const observations = parseTimeline(
      timeline([
        { date: '20261115T000000Z', value: 11 },
        { date: '20261113T000000Z', value: 425 },
        { date: '20261114T000000Z', value: 199 },
      ]),
      START,
      END,
    );
    assert.deepEqual(observations, [
      { day: '2026-11-13', value: 425 },
      { day: '2026-11-14', value: 199 },
      { day: '2026-11-15', value: 11 },
    ]);
  });

  it('keeps zero days rather than treating them as missing', () => {
    const observations = parseTimeline(
      timeline([
        { date: '20261113T000000Z', value: 0 },
        { date: '20261114T000000Z', value: 2 },
        { date: '20261115T000000Z', value: 0 },
      ]),
      START,
      END,
    );
    assert.deepEqual(
      observations.map((entry) => entry.value),
      [0, 2, 0],
    );
  });

  it('drops days GDELT omits and keeps the reported ones', () => {
    const start = Date.parse('2026-10-16T00:00:00Z');
    const points = Array.from({ length: 31 }, (_, offset) =>
      new Date(start + offset * 86_400_000).toISOString().slice(0, 10),
    )
      .filter((day) => day < '2026-10-28' || day > '2026-11-02')
      .map((day) => ({ date: `${day.replaceAll('-', '')}T000000Z`, value: 3 }));
    const observations = parseTimeline(timeline(points), '2026-10-16', '2026-11-15');
    assert.equal(observations.length, 25);
    assert.equal(observations.at(-1)?.day, '2026-11-15');
    assert.ok(!observations.some((entry) => entry.day === '2026-10-28'));
  });

  it('rejects a series that does not reach the target day', () => {
    assert.throws(
      () =>
        parseTimeline(
          timeline([
            { date: '20261113T000000Z', value: 1 },
            { date: '20261114T000000Z', value: 2 },
          ]),
          START,
          END,
        ),
      /no count for 2026-11-15/,
    );
  });

  it('rejects a series with too few days to be a baseline', () => {
    assert.throws(
      () =>
        parseTimeline(
          timeline([
            { date: '20261113T000000Z', value: 1 },
            { date: '20261115T000000Z', value: 1 },
          ]),
          START,
          END,
        ),
      (error: unknown) => error instanceof GdeltError && error.kind === 'incomplete-series',
    );
  });

  it('rejects days outside the requested range', () => {
    assert.throws(
      () =>
        parseTimeline(
          timeline([
            { date: '20261112T000000Z', value: 1 },
            { date: '20261113T000000Z', value: 1 },
            { date: '20261114T000000Z', value: 1 },
            { date: '20261115T000000Z', value: 1 },
          ]),
          START,
          END,
        ),
      /outside the requested range/,
    );
  });

  it('rejects a repeated day', () => {
    assert.throws(
      () =>
        parseTimeline(
          timeline([
            { date: '20261113T000000Z', value: 1 },
            { date: '20261113T000000Z', value: 2 },
            { date: '20261114T000000Z', value: 1 },
            { date: '20261115T000000Z', value: 1 },
          ]),
          START,
          END,
        ),
      /repeats/,
    );
  });

  it('rejects a malformed payload', () => {
    assert.throws(() => parseTimeline({}, START, END), GdeltError);
    assert.throws(
      () => parseTimeline(timeline([{ date: '20261113T000000Z', value: -1 }]), START, END),
      GdeltError,
    );
  });
});

describe('fetchArticles', () => {
  it('fetches the range in one request and hashes the response', async () => {
    const urls: string[] = [];
    const body = JSON.stringify(
      timeline([
        { date: '20261113T000000Z', value: 425 },
        { date: '20261114T000000Z', value: 199 },
        { date: '20261115T000000Z', value: 11 },
      ]),
    );
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(body);
    }) as typeof fetch;

    const fetched = await fetchArticles('Nvidia', START, END, { fetchImpl, spacingMs: 0 });
    assert.equal(urls.length, 1);
    assert.deepEqual(fetched.urls, urls);
    assert.equal(fetched.observations.at(-1)?.value, 11);
    assert.match(fetched.payloadSha256, /^[0-9a-f]{64}$/);
  });

  it('retries when GDELT answers a throttle as plain text', async () => {
    let calls = 0;
    const body = JSON.stringify(
      timeline([
        { date: '20261113T000000Z', value: 1 },
        { date: '20261114T000000Z', value: 2 },
        { date: '20261115T000000Z', value: 3 },
      ]),
    );
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('Please limit requests to one every 5 seconds', { status: 200 })
        : new Response(body);
    }) as typeof fetch;

    const fetched = await fetchArticles('Nvidia', START, END, { fetchImpl, spacingMs: 0 });
    assert.equal(calls, 2);
    assert.equal(fetched.observations.at(-1)?.value, 3);
  });

  it('reports a non-JSON body as malformed rather than crashing', async () => {
    const fetchImpl = (async () => new Response('<html>maintenance</html>')) as typeof fetch;
    await assert.rejects(
      fetchArticles('Nvidia', START, END, { fetchImpl, spacingMs: 0 }),
      (error: unknown) => error instanceof GdeltError && error.kind === 'malformed-response',
    );
  });
});
