/**
 * Image lookup for a topic whose article has no freely licensed picture.
 *
 * Wikipedia and Wikidata only carry media that may be republished, so a person
 * who is covered by press photography and little else resolves with no image.
 * This adapter asks a web image index for one instead. It is optional: without
 * a key discovery runs exactly as before and the card shows initials.
 */

const SERPER_ENDPOINT = 'https://google.serper.dev/images';

/** Key name read from the environment. Unset disables the lookup. */
export const IMAGE_SEARCH_KEY_ENV = 'SERPER_API_KEY';

/** Smallest image worth putting behind a card at full width. */
const MIN_WIDTH = 400;

export interface TopicImage {
  /** Direct image URL. */
  readonly imageUrl: string;
  /** Page the image was found on, kept so the source can be named or credited. */
  readonly sourceUrl: string | null;
}

/** The configured key, or null when image search is off. */
export function imageSearchKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[IMAGE_SEARCH_KEY_ENV];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/** A URL a browser can load over https, and not a format the cards cannot paint. */
function usableImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null;
  if (/\.(svg|gif)(\?|$)/i.test(value)) return null;
  return value;
}

/**
 * Whether the URL actually answers with a picture.
 *
 * A search result is a claim, not a file: social platforms hand out permalinks
 * that redirect to a page, and those paint as nothing on a card. The answer is
 * read and thrown away, so this costs a request and no memory.
 */
async function servesImage(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { method: 'GET' });
    await response.body?.cancel();
    return response.ok && (response.headers.get('content-type') ?? '').startsWith('image/');
  } catch {
    return false;
  }
}

/**
 * Best image for a search phrase, or null.
 *
 * The first result wide enough that also serves a picture wins. Getting nothing
 * is a normal outcome and never throws into a build: an image is presentation.
 */
export async function searchTopicImage(
  query: string,
  options: { readonly apiKey: string; readonly fetchImpl?: typeof fetch },
): Promise<TopicImage | null> {
  if (query.trim() === '') return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-KEY': options.apiKey,
      },
      body: JSON.stringify({ q: query, num: 10, safe: 'off' }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      images?: Array<{ imageUrl?: unknown; imageWidth?: unknown; link?: unknown }>;
    };
    for (const result of payload.images ?? []) {
      const imageUrl = usableImageUrl(result.imageUrl);
      if (imageUrl === null) continue;
      const width = typeof result.imageWidth === 'number' ? result.imageWidth : 0;
      if (width > 0 && width < MIN_WIDTH) continue;
      if (!(await servesImage(imageUrl, fetchImpl))) continue;
      const sourceUrl =
        typeof result.link === 'string' && result.link.startsWith('https://')
          ? result.link
          : null;
      return { imageUrl, sourceUrl };
    }
    return null;
  } catch {
    return null;
  }
}
