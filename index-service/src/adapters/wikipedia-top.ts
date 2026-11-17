import { sha256Hex } from '../domain/snapshot.ts';
import { toCompact } from '../domain/dates.ts';
import { fetchText, HttpError } from './http.ts';

/**
 * The most-viewed English Wikipedia articles for one UTC day.
 *
 * This is the discovery surface: it says what people actually looked up, with
 * no basket and no query terms. It is keyless and final for a completed day, so
 * it can be refetched and compared, but it is not part of the signed index and
 * never feeds settlement.
 */
const TOP_ROOT = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access';

export type WikipediaTopErrorKind = 'request-failed' | 'malformed-response';

export class WikipediaTopError extends Error {
  readonly kind: WikipediaTopErrorKind;

  constructor(kind: WikipediaTopErrorKind, message: string) {
    super(message);
    this.name = 'WikipediaTopError';
    this.kind = kind;
  }
}

/** One article in the daily ranking. */
export interface TopArticle {
  readonly article: string;
  readonly views: number;
  readonly rank: number;
}

export interface TopFetch {
  readonly urls: readonly string[];
  readonly retrievedAt: string;
  readonly payloadSha256: string;
  readonly articles: readonly TopArticle[];
}

/** Builds the public API URL for one day. The path needs plain YYYY/MM/DD. */
export function topArticlesUrl(day: string): string {
  const [year, month, date] = day.split('-');
  return `${TOP_ROOT}/${year}/${month}/${date}`;
}

/**
 * Keeps main-namespace articles only.
 *
 * The ranking mixes in reader-facing utility pages (Main_Page, Special:Search,
 * Wikipedia:Featured_pictures and the like). Those are real views but not a
 * topic anyone is paying attention to, and a colon is how every other namespace
 * announces itself.
 */
export function isTopicArticle(article: string): boolean {
  if (article === '' || article.includes(':')) {
    return false;
  }
  return article !== 'Main_Page';
}

/** Parses a top-articles response into ranked articles, utility pages dropped. */
export function parseTopArticles(payload: unknown): TopArticle[] {
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new WikipediaTopError('malformed-response', 'response has no items array');
  }
  const first = items[0] as { articles?: unknown };
  if (!Array.isArray(first.articles)) {
    throw new WikipediaTopError('malformed-response', 'day has no articles array');
  }
  const articles: TopArticle[] = [];
  for (const item of first.articles) {
    const record = item as { article?: unknown; views?: unknown; rank?: unknown };
    if (typeof record.article !== 'string' || typeof record.views !== 'number') {
      throw new WikipediaTopError('malformed-response', 'article missing name or views');
    }
    if (!isTopicArticle(record.article)) {
      continue;
    }
    articles.push({
      article: record.article,
      views: record.views,
      rank: typeof record.rank === 'number' ? record.rank : articles.length + 1,
    });
  }
  return articles.sort((a, b) => a.rank - b.rank);
}

/** Fetches the ranking for one completed UTC day. */
export async function fetchTopArticles(
  day: string,
  options: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<TopFetch> {
  const url = topArticlesUrl(day);
  let text: string;
  try {
    text = await fetchText(url, options.fetchImpl);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new WikipediaTopError('request-failed', error.message);
    }
    throw error;
  }
  const now = options.now?.() ?? new Date();
  return {
    urls: [url],
    retrievedAt: now.toISOString(),
    payloadSha256: sha256Hex(text),
    articles: parseTopArticles(JSON.parse(text)),
  };
}

const SUMMARY_ROOT = 'https://en.wikipedia.org/api/rest_v1/page/summary';

/**
 * Lead image for one article, at a width the cards can use.
 *
 * Presentation only: a missing thumbnail returns null and the card falls back to
 * its gradient, so an image problem can never block a build.
 */
export async function fetchArticleImage(
  article: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const url = `${SUMMARY_ROOT}/${encodeURIComponent(article.replaceAll(' ', '_'))}`;
  try {
    const text = await fetchText(url, options.fetchImpl);
    const payload = JSON.parse(text) as { thumbnail?: { source?: unknown } };
    const source = payload.thumbnail?.source;
    if (typeof source !== 'string' || !source.startsWith('https://')) {
      return null;
    }
    // Keep the width the API chose: asking the thumbnail service for an
    // arbitrary one returns 400 for files whose size is already cached.
    return source.split('?')[0] ?? null;
  } catch {
    return null;
  }
}
