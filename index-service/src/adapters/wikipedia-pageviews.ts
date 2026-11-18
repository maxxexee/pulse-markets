import type { DailyObservation } from '../domain/observation.ts';
import { toCompact } from '../domain/dates.ts';
import { sha256Hex } from '../domain/snapshot.ts';
import { HttpError, fetchText } from './http.ts';

export { DEFAULT_USER_AGENT } from './http.ts';

const API_ROOT = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article';

export type WikipediaErrorKind = 'unknown-article' | 'request-failed' | 'malformed-response';

export class WikipediaError extends Error {
  readonly kind: WikipediaErrorKind;

  constructor(kind: WikipediaErrorKind, message: string) {
    super(message);
    this.name = 'WikipediaError';
    this.kind = kind;
  }
}

/** One successful fetch, including the provenance needed to audit it. */
export interface PageviewsFetch {
  readonly urls: readonly string[];
  readonly retrievedAt: string;
  readonly payloadSha256: string;
  /** Raw response body, kept so a multi-project fetch can hash its inputs. */
  readonly body: string;
  readonly observations: readonly DailyObservation[];
}

/**
 * Builds the public API URL for one article over an inclusive day range.
 *
 * The project defaults to English Wikipedia. Other language editions are named
 * explicitly by a definition that reads them, so the pages a signal reads are
 * always the pages it publishes.
 */
export function pageviewsUrl(
  article: string,
  startDay: string,
  endDay: string,
  project = 'en.wikipedia',
): string {
  const title = encodeURIComponent(article.replaceAll(' ', '_'));
  return `${API_ROOT}/${project}/all-access/user/${title}/daily/${toCompact(startDay)}/${toCompact(endDay)}`;
}

/**
 * Converts a pageviews response into daily observations.
 *
 * The API timestamps are YYYYMMDDHH; only the day part is retained because the
 * index scores complete UTC days.
 */
export function parsePageviews(payload: unknown): DailyObservation[] {
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    throw new WikipediaError('malformed-response', 'response has no items array');
  }
  const byDay = new Map<string, number>();
  for (const item of items) {
    const record = item as { timestamp?: unknown; views?: unknown };
    if (typeof record.timestamp !== 'string' || typeof record.views !== 'number') {
      throw new WikipediaError('malformed-response', 'item missing timestamp or views');
    }
    const day = `${record.timestamp.slice(0, 4)}-${record.timestamp.slice(4, 6)}-${record.timestamp.slice(6, 8)}`;
    byDay.set(day, (byDay.get(day) ?? 0) + record.views);
  }
  return [...byDay.entries()]
    .map(([day, value]) => ({ day, value }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Fetches daily pageviews for one article over an inclusive day range. */
export async function fetchPageviews(
  article: string,
  startDay: string,
  endDay: string,
  options: { fetchImpl?: typeof fetch; now?: () => Date; project?: string } = {},
): Promise<PageviewsFetch> {
  const url = pageviewsUrl(article, startDay, endDay, options.project);
  let text: string;
  try {
    text = await fetchText(url, options.fetchImpl);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new WikipediaError(
        error.status === 404 ? 'unknown-article' : 'request-failed',
        error.message,
      );
    }
    throw error;
  }
  const now = options.now?.() ?? new Date();
  return {
    urls: [url],
    retrievedAt: now.toISOString(),
    payloadSha256: sha256Hex(text),
    body: text,
    observations: parsePageviews(JSON.parse(text)),
  };
}
