import {
  mentionsTopic,
  summarizeSocial,
  summarizeTopic,
  type SocialPanel,
  type SocialPost,
  type SocialTopicPanel,
  type SocialTopicQuery,
} from '@pulse/index-core/social.ts';

/** Vendor endpoint the vendor documents for search. */
const API_BASE = 'https://api.twitterapi.io';

/** Pages fetched per build: 40 posts is enough to read the room. */
export const SOCIAL_PAGE_LIMIT = 2;

/** One page per topic is 20 posts, which is more than a two-line strip can use. */
export const TOPIC_PAGE_LIMIT = 1;

/**
 * One topic at a time, with a pause between them.
 *
 * The vendor answers a burst with 403/429 rather than a partial result, and one
 * run of thirteen parallel queries published four pages and dropped nine
 * silently.
 */
export const TOPIC_DELAY_MS = 1_200;

/** How long a refused topic waits before its one retry. */
const TOPIC_RETRY_MS = 8_000;

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
    source: 'x',
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
async function fetchPosts(
  apiKey: string,
  query: string,
  fetchImpl: typeof fetch,
  pageLimit: number,
): Promise<{ readonly posts: readonly SocialPost[]; readonly truncated: boolean }> {
  const posts: SocialPost[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;

  while (pages < pageLimit) {
    const page = await fetchPage(apiKey, query, cursor, fetchImpl);
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

  return { posts, truncated };
}

function assertConfigured(apiKey: string): void {
  if (apiKey.trim() === '') {
    throw new SocialError('not-configured', `${SOCIAL_KEY_ENV} is not set`);
  }
}

export async function fetchSocialPanel(options: SocialFetchOptions): Promise<SocialPanel> {
  assertConfigured(options.apiKey);
  const { posts, truncated } = await fetchPosts(
    options.apiKey,
    options.query,
    options.fetchImpl ?? fetch,
    options.pageLimit ?? SOCIAL_PAGE_LIMIT,
  );
  return summarizeSocial({
    query: options.query,
    fetchedAt: options.now.toISOString(),
    posts,
    truncated,
  });
}

/**
 * Fetches one panel per page instead of one for the whole basket.
 *
 * A shared basket query is what put posts about Nvidia on Jensen Huang's page:
 * the vendor answered a single OR of every label, and the page then kept any
 * post containing the word. Asking per topic keeps the page about its topic, and
 * the label check drops the posts the vendor matched on something other than
 * the text.
 *
 * A topic that fails is left out and the rest still publish: the strip is
 * display only, so one odd query must not blank every page.
 */
export async function fetchSocialTopics(options: {
  readonly apiKey: string;
  readonly topics: readonly SocialTopicQuery[];
  readonly now: Date;
  readonly fetchImpl?: typeof fetch;
  readonly pageLimit?: number;
  /** Pause between topics; zero keeps the loop instant for tests. */
  readonly delayMs?: number;
  /** Pause before a topic's retry; zero keeps the loop instant for tests. */
  readonly retryMs?: number;
  readonly log?: (line: string) => void;
}): Promise<Record<string, SocialTopicPanel>> {
  assertConfigured(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageLimit = options.pageLimit ?? TOPIC_PAGE_LIMIT;
  const delayMs = options.delayMs ?? TOPIC_DELAY_MS;
  const retryMs = options.retryMs ?? TOPIC_RETRY_MS;
  const log = options.log ?? ((): void => undefined);
  const panels: Record<string, SocialTopicPanel> = {};

  for (const [index, topic] of options.topics.entries()) {
    if (index > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const read = async () => fetchPosts(options.apiKey, topic.query, fetchImpl, pageLimit);
    let posts: readonly SocialPost[];
    try {
      ({ posts } = await read());
    } catch (error) {
      // One retry, then the page is left without a strip rather than taking the
      // rest of the panel down with it. The reason goes to the build log, because
      // a page with no tweets and a refused query look identical on the site.
      const detail = error instanceof Error ? error.message : String(error);
      log(`social topic ${topic.key} failed (${detail}), retrying`);
      try {
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        ({ posts } = await read());
      } catch (retryError) {
        const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
        log(`social topic ${topic.key} skipped: ${retryDetail}`);
        continue;
      }
    }
    panels[topic.key] = summarizeTopic({
      label: topic.label,
      query: topic.query,
      posts: posts.filter((post) => mentionsTopic(post.text, topic.label)),
    });
  }
  return panels;
}
