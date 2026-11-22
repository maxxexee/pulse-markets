import {
  mentionKey,
  mentionsTopic,
  summarizeTopic,
  type SocialPost,
  type SocialTopicPanel,
  type SocialTopicQuery,
} from '@pulse/index-core/social.ts';

/**
 * The free, keyless half of the social panel.
 *
 * The AppView answers a search without an account, and nothing here is billed,
 * so this source does not expire the way a credit balance does. What it does not
 * have is view counts: the protocol records likes, reposts, replies and quotes,
 * never impressions, so a post from here carries `views: null` and the page
 * shows only the likes.
 *
 * `public.api.bsky.app` refuses unauthenticated search as of late 2026 while
 * `api.bsky.app` still answers, so this asks the host that works and treats a
 * refusal as "no posts from this network" rather than as a failed panel.
 */
const API_BASE = 'https://api.bsky.app';

/** One page is 25 posts, which is far more than a two-line strip can use. */
export const BLUESKY_LIMIT = 25;

/** Sequential and paced: the host is free, so there is no reason to burst it. */
export const BLUESKY_DELAY_MS = 600;

const RETRY_MS = 4_000;

export class BlueskyError extends Error {
  readonly kind: 'request-failed' | 'malformed';

  constructor(kind: BlueskyError['kind'], message: string) {
    super(message);
    this.name = 'BlueskyError';
    this.kind = kind;
  }
}

interface SearchBody {
  readonly posts?: unknown;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads one post, or null for an entry missing what a strip needs. */
export function parsePost(raw: unknown): SocialPost | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const post = raw as Record<string, unknown>;
  const uri = text(post['uri']);
  const author = post['author'];
  const record = post['record'];
  if (uri === null || author === null || typeof author !== 'object') {
    return null;
  }
  if (record === null || typeof record !== 'object') {
    return null;
  }
  const handle = text((author as Record<string, unknown>)['handle']);
  const fields = record as Record<string, unknown>;
  const body = (text(fields['text']) ?? '').replace(/\s+/g, ' ').trim();
  // The record carries when it was written; indexedAt is when the AppView saw
  // it, which is later and would make every post look newer than it is.
  const createdAt = text(fields['createdAt']) ?? text(post['indexedAt']);
  if (handle === null || createdAt === null || body === '') {
    return null;
  }
  const rkey = uri.split('/').at(-1) ?? '';
  return {
    id: uri,
    author: handle,
    text: body,
    createdAt,
    likes: count(post['likeCount']),
    views: null,
    url: `https://bsky.app/profile/${handle}/post/${rkey}`,
    source: 'bluesky',
  };
}

function parseSearch(body: string): readonly SocialPost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BlueskyError('malformed', 'bluesky response is not JSON');
  }
  const posts = (parsed as SearchBody | null)?.posts;
  if (!Array.isArray(posts)) {
    throw new BlueskyError('malformed', 'bluesky response has no posts array');
  }
  const parsedPosts: SocialPost[] = [];
  for (const raw of posts) {
    const post = parsePost(raw);
    if (post !== null) {
      parsedPosts.push(post);
    }
  }
  return parsedPosts;
}

async function search(
  term: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<readonly SocialPost[]> {
  const url = new URL('/xrpc/app.bsky.feed.searchPosts', API_BASE);
  url.searchParams.set('q', term);
  url.searchParams.set('limit', String(limit));
  // The ranked result, for the same reason the X adapter asks for Top: the
  // newest 25 posts are mostly replies to something already popular.
  url.searchParams.set('sort', 'top');
  url.searchParams.set('lang', 'en');

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BlueskyError('request-failed', `bluesky request failed: ${detail}`);
  }
  if (!response.ok) {
    throw new BlueskyError('request-failed', `bluesky request returned HTTP ${response.status}`);
  }
  return parseSearch(await response.text());
}

/**
 * One panel per page, keyed the way the dashboard routes it.
 *
 * A page is left out when the network refuses or returns nothing, which is why
 * the caller merges these with whatever another source answered instead of
 * replacing it.
 */
export async function fetchBlueskyTopics(
  topics: readonly SocialTopicQuery[],
  options: {
    readonly now: Date;
    readonly fetchImpl?: typeof fetch;
    readonly limit?: number;
    readonly delayMs?: number;
    readonly retryMs?: number;
    readonly log?: (line: string) => void;
  },
): Promise<Record<string, SocialTopicPanel>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.limit ?? BLUESKY_LIMIT;
  const delayMs = options.delayMs ?? BLUESKY_DELAY_MS;
  const retryMs = options.retryMs ?? RETRY_MS;
  const log = options.log ?? ((): void => undefined);
  const panels: Record<string, SocialTopicPanel> = {};

  for (const [index, topic] of topics.entries()) {
    if (index > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const key = mentionKey(topic.label);
    if (key === '') {
      continue;
    }
    // Searched as written, matched in lower case: the index treats "Nvidia" and
    // "nvidia" the same, so only the match needs normalising.
    const term = topic.label.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    let posts: readonly SocialPost[];
    try {
      posts = await search(term, fetchImpl, limit);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`bluesky topic ${topic.key} failed (${detail}), retrying`);
      try {
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        posts = await search(term, fetchImpl, limit);
      } catch (retryError) {
        const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
        log(`bluesky topic ${topic.key} skipped: ${retryDetail}`);
        continue;
      }
    }
    const mentions = posts.filter((post) => mentionsTopic(post.text, topic.label));
    if (mentions.length === 0) {
      continue;
    }
    panels[topic.key] = summarizeTopic({ label: topic.label, query: term, posts: mentions });
  }
  return panels;
}
