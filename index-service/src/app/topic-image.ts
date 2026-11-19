import { imageSearchKey, searchTopicImage } from '../adapters/image-search.ts';
import { fetchArticleImage } from '../adapters/wikipedia-top.ts';
import { curatedImage } from '../config/topic-images.ts';
import type { DiscoveredTopic } from '@pulse/index-core/discovery.ts';

/** An image for a card, and the page it came from when that is worth naming. */
export interface ResolvedImage {
  readonly url: string | null;
  readonly source: string | null;
}

/**
 * Picture for one topic.
 *
 * The article's own image may be republished, so it wins. A curated entry is an
 * explicit choice by the project and comes next. Only then is a web image search
 * consulted, because those pictures belong to whoever published them and the
 * entry records the page they were found on.
 */
export async function resolveTopicImage(
  topic: DiscoveredTopic,
  args: {
    /** null disables the search step. */
    readonly searchKey: string | null;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<ResolvedImage> {
  const fetcher = args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl };
  const fromArticle = await fetchArticleImage(topic.article, fetcher);
  if (fromArticle !== null) return { url: fromArticle, source: null };
  const curated = curatedImage(topic.article);
  if (curated !== null) return { url: curated, source: null };
  if (args.searchKey === null) return { url: null, source: null };
  const found = await searchTopicImage(topic.topic, { apiKey: args.searchKey, ...fetcher });
  return found === null
    ? { url: null, source: null }
    : { url: found.imageUrl, source: found.sourceUrl };
}

/** Key for the search step, or null when image search is not configured. */
export { imageSearchKey };
