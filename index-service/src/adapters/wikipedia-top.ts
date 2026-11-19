import type { TopArticle } from '@pulse/index-core/discovery.ts';
import { toCompact } from '@pulse/index-core/dates.ts';
import { sha256Hex } from '@pulse/index-core/snapshot.ts';
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

/** Re-exported so ranking consumers do not depend on the core package directly. */
export type { TopArticle };

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

/** Plain opening of one article, used to ground a context note. */
export interface ArticleExtract {
  /** Plain text lead section, possibly empty. */
  readonly extract: string;
  /** Short type phrase, such as "American singer", or null. */
  readonly description: string | null;
  /** Canonical article URL, recorded as the source of the note. */
  readonly url: string;
}

/**
 * Fetches the lead section of one article.
 *
 * Returns null rather than throwing: a note without grounding is not written,
 * and a discovery day is presentation, so one unreadable page cannot fail it.
 */
export async function fetchArticleExtract(
  article: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ArticleExtract | null> {
  const url = `${SUMMARY_ROOT}/${encodeURIComponent(article.replaceAll(' ', '_'))}`;
  try {
    const text = await fetchText(url, options.fetchImpl);
    const payload = JSON.parse(text) as {
      extract?: unknown;
      description?: unknown;
      content_urls?: { desktop?: { page?: unknown } };
    };
    const extract = typeof payload.extract === 'string' ? payload.extract.trim() : '';
    if (extract === '') {
      return null;
    }
    const page = payload.content_urls?.desktop?.page;
    return {
      extract,
      description: typeof payload.description === 'string' ? payload.description : null,
      url: typeof page === 'string' && page.startsWith('https://')
        ? page
        : `https://en.wikipedia.org/wiki/${encodeURIComponent(article)}`,
    };
  } catch {
    return null;
  }
}

const PAGE_PROPS_ROOT = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_ENTITY_ROOT = 'https://www.wikidata.org/wiki/Special:EntityData';
const COMMONS_FILE_ROOT = 'https://commons.wikimedia.org/wiki/Special:FilePath';

/** Width the cards and modal can use without downloading a full original. */
const IMAGE_WIDTH = 330;

/**
 * Image recorded on the Wikidata item, when the article itself has none.
 *
 * P18 is curated and file-scoped, unlike a Commons category search, which can
 * return a photo of the subject's office and look like a wrong portrait.
 */
async function imageFromWikidata(
  article: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const propsUrl = new URL(PAGE_PROPS_ROOT);
  propsUrl.searchParams.set('action', 'query');
  propsUrl.searchParams.set('titles', article.replaceAll('_', ' '));
  propsUrl.searchParams.set('prop', 'pageprops');
  propsUrl.searchParams.set('format', 'json');
  propsUrl.searchParams.set('formatversion', '2');
  const props = JSON.parse(await fetchText(propsUrl.toString(), fetchImpl)) as {
    query?: { pages?: Array<{ pageprops?: { wikibase_item?: unknown } }> };
  };
  const qid = props.query?.pages?.[0]?.pageprops?.wikibase_item;
  if (typeof qid !== 'string' || !/^Q\d+$/.test(qid)) {
    return null;
  }
  const entity = JSON.parse(
    await fetchText(`${WIKIDATA_ENTITY_ROOT}/${qid}.json`, fetchImpl),
  ) as {
    entities?: Record<string, { claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: unknown } } }> } }>;
  };
  const file = entity.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (typeof file !== 'string' || file.trim() === '') {
    return null;
  }
  return `${COMMONS_FILE_ROOT}/${encodeURIComponent(file.replaceAll(' ', '_'))}?width=${IMAGE_WIDTH}`;
}

/**
 * Lead image for one article, at a width the cards can use.
 *
 * The Wikipedia summary is tried first, then the Wikidata image. Presentation
 * only: when both are missing this returns null and the card shows initials, so
 * an image problem can never block a build.
 */
export async function fetchArticleImage(
  article: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${SUMMARY_ROOT}/${encodeURIComponent(article.replaceAll(' ', '_'))}`;
  try {
    const text = await fetchText(url, fetchImpl);
    const payload = JSON.parse(text) as { thumbnail?: { source?: unknown } };
    const source = payload.thumbnail?.source;
    if (typeof source === 'string' && source.startsWith('https://')) {
      // Keep the width the API chose: asking the thumbnail service for an
      // arbitrary one returns 400 for files whose size is already cached.
      return source.split('?')[0] ?? null;
    }
  } catch {
    // Fall through to Wikidata: an article with no summary can still have one.
  }
  try {
    return await imageFromWikidata(article, fetchImpl);
  } catch {
    return null;
  }
}
