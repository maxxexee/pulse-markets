import { summarizeSocial, type SocialPanel, type SocialPost } from '@pulse/index-core/social.ts';

/** Vendor endpoint the vendor documents for search. */
const API_BASE = 'https://api.twitterapi.io';

/** Pages fetched per build: 40 posts is enough to read the room. */
export const SOCIAL_PAGE_LIMIT = 2;

/**
 * The vendor's ranked list, not a recency feed. `Latest` answers with whatever
 * was posted in the last minute — measured at 40 posts spanning 46 seconds and
 * 5 likes in total — so the panel is built from `Top`, which ranks by
 * engagement and mixes in older posts that people actually read.
 */
const QUERY_TYPE = 'Top';

/** Environment variable holding the vendor key. Keys are never CLI arguments. */
export const SOCIAL_KEY_ENV = 'TWITTERAPI_IO_KEY';

export class SocialError extends Error {
  readonly kind: 'not-configured' | 'request-failed' | 'malformed';

  constructor(kind: SocialError['kind'], message: string) {
    super(message);
    this.name = 'SocialError';
    this.kind = kind;
  }
}

export interface SocialFetchOptions {
  readonly apiKey: string;
  readonly query: string;
  readonly now: Date;
  readonly fetchImpl?: typeof fetch;
  readonly pageLimit?: number;
}

interface TweetPage {
  readonly tweets: readonly SocialPost[];
  readonly nextCursor: string | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads one tweet, returning null for an entry missing what the panel needs. */
function parseTweet(raw: unknown): SocialPost | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const tweet = raw as Record<string, unknown>;
  const id = text(tweet['id'] ?? tweet['id_str']);
  const createdAt = text(tweet['createdAt'] ?? tweet['created_at']);
  const author = tweet['author'];
  const userName =
    author !== null && typeof author === 'object'
      ? text((author as Record<string, unknown>)['userName'])
      : null;
  if (id === null || createdAt === null || userName === null) {
    return null;
  }
  // Retweets are the cheapest thing to inflate, so they never reach the panel.
  // The query cannot exclude them (see socialQuery), so they are dropped here.
  const retweeted = tweet['retweeted_tweet'];
  if (tweet['isRetweet'] === true || (retweeted !== null && retweeted !== undefined)) {
    return null;
  }
  const url = text(tweet['url']) ?? `https://x.com/${userName}/status/${id}`;
  // Collapsed so a post renders on one line whatever the source formatting is.
  const body = (text(tweet['text']) ?? '').replace(/\s+/g, ' ').trim();
  return {
    id,
    author: userName,
    text: body,
    createdAt,
    likes: count(tweet['likeCount']) ?? 0,
    views: count(tweet['viewCount']),
    url,
  };
}

function parsePage(body: string): TweetPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SocialError('malformed', 'social response is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new SocialError('malformed', 'social response is not an object');
  }
  const page = parsed as Record<string, unknown>;
  const rawTweets = page['tweets'];
  if (!Array.isArray(rawTweets)) {
    throw new SocialError('malformed', 'social response has no tweets array');
  }
  const tweets: SocialPost[] = [];
  for (const raw of rawTweets) {
    const tweet = parseTweet(raw);
    if (tweet !== null) {
      tweets.push(tweet);
    }
  }
  const nextCursor =
    page['has_next_page'] === true && typeof page['next_cursor'] === 'string'
      ? page['next_cursor']
      : null;
  return { tweets, nextCursor };
}

async function fetchPage(
  apiKey: string,
  query: string,
  cursor: string | null,
  fetchImpl: typeof fetch,
): Promise<TweetPage> {
  const url = new URL('/twitter/tweet/advanced_search', API_BASE);
  url.searchParams.set('query', query);
  url.searchParams.set('queryType', QUERY_TYPE);
  if (cursor !== null) {
    url.searchParams.set('cursor', cursor);
  }
  // The vendor answers a slice of otherwise identical searches with 503
  // ("couldn't be completed right now", uncharged) and 429 on bursts. Both are
  // transient, so the page is retried before the panel gives up.
  const RESPONSE_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { 'x-api-key': apiKey, accept: 'application/json' },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SocialError('request-failed', `social request failed: ${detail}`);
    }
    if (response.ok) {
      return parsePage(await response.text());
    }
    const transient = response.status === 503 || response.status === 429;
    if (transient && attempt < RESPONSE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      continue;
    }
    throw new SocialError('request-failed', `social request returned HTTP ${response.status}`);
  }
}

/**
 * Fetches the social panel.
 *
 * The key is required and never defaulted: without it this throws
 * `not-configured` so the caller can report the panel as absent rather than
 * publish an empty one that looks like nobody is talking.
 */
export async function fetchSocialPanel(options: SocialFetchOptions): Promise<SocialPanel> {
  if (options.apiKey.trim() === '') {
    throw new SocialError('not-configured', `${SOCIAL_KEY_ENV} is not set`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageLimit = options.pageLimit ?? SOCIAL_PAGE_LIMIT;
  const posts: SocialPost[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;

  while (pages < pageLimit) {
    const page = await fetchPage(options.apiKey, options.query, cursor, fetchImpl);
    pages += 1;
    for (const tweet of page.tweets) {
      if (!seen.has(tweet.id)) {
        seen.add(tweet.id);
        posts.push(tweet);
      }
    }
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
    truncated = pages >= pageLimit;
  }

  return summarizeSocial({
    query: options.query,
    fetchedAt: options.now.toISOString(),
    posts,
    truncated,
  });
}
