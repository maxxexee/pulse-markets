import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WikipediaError, pageviewsUrl, parsePageviews } from '../src/adapters/wikipedia-pageviews.ts';

const RESPONSE = {
  items: [
    { timestamp: '2026111200', views: 1072168 },
    { timestamp: '2026110500', views: 4819 },
    { timestamp: '2026110600', views: 6023 },
  ],
};

describe('pageviewsUrl', () => {
  it('builds the documented endpoint for a plain title', () => {
    assert.equal(
      pageviewsUrl('Jensen_Huang', '2026-10-16', '2026-11-15'),
      'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/' +
        'all-access/user/Jensen_Huang/daily/20261016/20261115',
    );
  });

  it('encodes spaces as underscores', () => {
    assert.match(pageviewsUrl('Sam Altman', '2026-10-16', '2026-11-15'), /Sam_Altman/);
  });

  it('rejects an invalid day range', () => {
    assert.throws(() => pageviewsUrl('Nvidia', '16-10-2026', '2026-11-15'), /invalid day/);
  });
});

describe('parsePageviews', () => {
  it('converts timestamps to days and sorts ascending', () => {
    assert.deepEqual(parsePageviews(RESPONSE), [
      { day: '2026-11-05', views: 4819 },
      { day: '2026-11-06', views: 6023 },
      { day: '2026-11-12', views: 1072168 },
    ]);
  });

  it('sums duplicate days rather than keeping the last', () => {
    const payload = {
      items: [
        { timestamp: '2026110500', views: 10 },
        { timestamp: '2026110513', views: 5 },
      ],
    };
    assert.deepEqual(parsePageviews(payload), [{ day: '2026-11-05', views: 15 }]);
  });

  it('throws a typed error when the shape is wrong', () => {
    assert.throws(
      () => parsePageviews({}),
      (error: unknown) =>
        error instanceof WikipediaError && error.kind === 'malformed-response',
    );
  });

  it('throws when an item has non-numeric views', () => {
    assert.throws(
      () => parsePageviews({ items: [{ timestamp: '2026110500', views: '10' }] }),
      (error: unknown) =>
        error instanceof WikipediaError && error.kind === 'malformed-response',
    );
  });
});
