/**
 * Maps a trend phrase to the English Wikipedia article a reader would land on.
 *
 * Discovery only holds a trend name, while every measurement is per article, so
 * a name that cannot be resolved is dropped rather than guessed. The search API
 * is used instead of string matching because trends arrive as hashtags, casing
 * variants and shorthand that no local rule covers.
 */

import { fetchText } from './http.ts';

const SEARCH_ROOT = 'https://en.wikipedia.org/w/api.php';

/** Spaces and punctuation are noise to the search API but change its ranking. */
export function searchQuery(name: string): string {
  return name
    .replace(/^[#@]+/, '')
    .replace(/[^\p{L}\p{N}\s'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Article title with underscores, the form the pageview API expects. */
export function articleFromTitle(title: string): string {
  return title.trim().replaceAll(' ', '_');
}

export interface TrendResolution {
  /** Trend name as the vendor gave it. */
  readonly name: string;
  /** Resolved article, or null when nothing usable came back. */
  readonly article: string | null;
}

/**
 * Resolves one trend name, returning null on any failure.
 *
 * Discovery cannot fail the day over one unmapped trend, and the caller then
 * measures whatever article was found with the normal baseline rules.
 */
export async function resolveTrendArticle(
  name: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const query = searchQuery(name);
  if (query.length < 2) {
    return null;
  }
  const url = new URL(SEARCH_ROOT);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srlimit', '1');
  url.searchParams.set('srnamespace', '0');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  try {
    const text = await fetchText(url.toString(), options.fetchImpl ?? fetch);
    const payload = JSON.parse(text) as { query?: { search?: unknown } };
    const results = payload.query?.search;
    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }
    const title = (results[0] as { title?: unknown }).title;
    if (typeof title !== 'string' || title.trim() === '') {
      return null;
    }
    return articleFromTitle(title);
  } catch {
    return null;
  }
}
