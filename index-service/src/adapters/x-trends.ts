/**
 * Trending topics on X, read only to widen the discovery candidate pool.
 *
 * The vendor returns a ranked list of names, not per-day volumes, so nothing
 * here can be scored: discovery still measures each resolved article with the
 * same pageview baseline it uses for the Wikipedia ranking. Counts are not
 * invented from the rank.
 */

const API_BASE = 'https://api.twitterapi.io';

/** Same key as the social panel; one vendor account covers both. */
export const X_TRENDS_KEY_ENV = 'TWITTERAPI_IO_KEY';

/** Worldwide. A country list would narrow discovery to that country's news. */
export const X_TRENDS_WOEID = 1;

/** The vendor's minimum is 30, and the tail is noise for this purpose. */
export const X_TRENDS_COUNT = 30;

export type XTrendsErrorKind = 'not-configured' | 'request-failed' | 'malformed';

export class XTrendsError extends Error {
  readonly kind: XTrendsErrorKind;

  constructor(kind: XTrendsErrorKind, message: string) {
    super(message);
    this.name = 'XTrendsError';
    this.kind = kind;
  }
}

/** One ranked trend, before it is mapped to an article. */
export interface XTrend {
  readonly name: string;
  readonly rank: number;
}

export interface XTrendsResult {
  readonly url: string;
  readonly retrievedAt: string;
  readonly trends: readonly XTrend[];
}

/** Reads the key, returning null instead of an empty string when it is absent. */
export function xTrendsKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env[X_TRENDS_KEY_ENV]?.trim();
  return key === undefined || key === '' ? null : key;
}

function parse(payload: unknown): readonly XTrend[] {
  if (payload === null || typeof payload !== 'object') {
    throw new XTrendsError('malformed', 'response is not an object');
  }
  const trends = (payload as { trends?: unknown }).trends;
  if (!Array.isArray(trends)) {
    throw new XTrendsError('malformed', 'response has no trends array');
  }
  const parsed: XTrend[] = [];
  for (const entry of trends) {
    if (entry === null || typeof entry !== 'object') continue;
    const trend = (entry as { trend?: unknown }).trend;
    if (trend === null || typeof trend !== 'object') continue;
    const name = (trend as { name?: unknown }).name;
    const rank = (trend as { rank?: unknown }).rank;
    if (typeof name !== 'string' || name.trim() === '') continue;
    if (typeof rank !== 'number' || !Number.isFinite(rank)) continue;
    parsed.push({ name: name.trim(), rank });
  }
  return parsed.sort((a, b) => a.rank - b.rank);
}

export interface XTrendsOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly woeid?: number;
  readonly count?: number;
}

export async function fetchXTrends(options: XTrendsOptions): Promise<XTrendsResult> {
  const apiKey = options.apiKey.trim();
  if (apiKey === '') {
    throw new XTrendsError('not-configured', `${X_TRENDS_KEY_ENV} is not set`);
  }
  const url = new URL('/twitter/trends', API_BASE);
  url.searchParams.set('woeid', String(options.woeid ?? X_TRENDS_WOEID));
  url.searchParams.set('count', String(options.count ?? X_TRENDS_COUNT));

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url.toString(), {
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new XTrendsError('request-failed', `trends request failed: ${detail}`);
  }
  if (!response.ok) {
    throw new XTrendsError('request-failed', `trends request returned HTTP ${response.status}`);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new XTrendsError('malformed', 'response is not JSON');
  }
  return {
    url: url.toString(),
    retrievedAt: (options.now?.() ?? new Date()).toISOString(),
    trends: parse(payload),
  };
}
