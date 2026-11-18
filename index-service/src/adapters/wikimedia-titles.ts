import { HttpError, fetchText } from './http.ts';

const API_ROOT = 'https://www.wikidata.org/w/api.php';

/**
 * Language editions read by the non-English pageview signal.
 *
 * A fixed list is part of the definition, not a preference: adding or removing
 * an edition changes which readers the index measures. Titles are resolved once
 * during calibration and frozen into the definition, so a build never asks
 * Wikidata what a page is called.
 */
export const GLOBAL_LANGUAGES = ['de', 'fr', 'es', 'ja', 'ru', 'zh'] as const;

/**
 * Editions that must resolve for a constituent to be calibratable.
 *
 * Below this, the article is missing from too much of the list for the sum to
 * describe non-English readership, and the definition would publish a number
 * measured over a different set of pages than its siblings.
 */
export const MIN_GLOBAL_LANGUAGES = 4;

export type TitleErrorKind = 'request-failed' | 'no-sitelinks' | 'malformed-response';

export class TitleError extends Error {
  readonly kind: TitleErrorKind;

  constructor(kind: TitleErrorKind, message: string) {
    super(message);
    this.name = 'TitleError';
    this.kind = kind;
  }
}

/** Public sitelink query for one English article title. */
export function sitelinksUrl(article: string): string {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    sites: 'enwiki',
    titles: article.replaceAll(' ', '_'),
    props: 'sitelinks',
    format: 'json',
  });
  return `${API_ROOT}?${params.toString()}`;
}

/**
 * Reads the title of the same page in each requested language edition.
 *
 * Wikidata keys sitelinks as `<language>wiki`, and an entity can lack an
 * edition entirely. Missing editions are omitted rather than guessed, and the
 * caller decides whether enough of them resolved.
 */
export function titlesFromSitelinks(
  payload: unknown,
  languages: readonly string[] = GLOBAL_LANGUAGES,
): Record<string, string> {
  const entities = (payload as { entities?: unknown } | null)?.entities;
  if (entities === null || typeof entities !== 'object') {
    throw new TitleError('malformed-response', 'response has no entities object');
  }
  const first = Object.values(entities as Record<string, unknown>)[0];
  const sitelinks = (first as { sitelinks?: unknown } | null)?.sitelinks;
  if (sitelinks === null || typeof sitelinks !== 'object') {
    throw new TitleError('no-sitelinks', 'entity has no sitelinks');
  }
  const links = sitelinks as Record<string, { title?: unknown } | undefined>;
  const titles: Record<string, string> = {};
  for (const language of languages) {
    const title = links[`${language}wiki`]?.title;
    if (typeof title === 'string' && title.trim() !== '') {
      titles[language] = title;
    }
  }
  if (Object.keys(titles).length < MIN_GLOBAL_LANGUAGES) {
    throw new TitleError(
      'no-sitelinks',
      `resolved ${Object.keys(titles).length} of ${languages.length} editions, ` +
        `need ${MIN_GLOBAL_LANGUAGES}`,
    );
  }
  return titles;
}

/** Resolves one article's titles in the configured language editions. */
export async function fetchTitles(
  article: string,
  options: { fetchImpl?: typeof fetch; languages?: readonly string[] } = {},
): Promise<Record<string, string>> {
  const url = sitelinksUrl(article);
  let text: string;
  try {
    text = await fetchText(url, options.fetchImpl);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new TitleError('request-failed', error.message);
    }
    throw error;
  }
  return titlesFromSitelinks(JSON.parse(text), options.languages ?? GLOBAL_LANGUAGES);
}
