import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chatConfigFromEnv, type ChatConfig } from '../adapters/chat-completion.ts';
import { fetchPageviews } from '../adapters/wikipedia-pageviews.ts';
import { fetchArticleImage, fetchTopArticles } from '../adapters/wikipedia-top.ts';
import { resolveTrendArticle } from '../adapters/wikipedia-search.ts';
import { fetchXTrends, xTrendsKey, X_TRENDS_WOEIDS } from '../adapters/x-trends.ts';
import type { EntityDefinition } from '../config/entities.ts';
import { mapWithConcurrency } from '@pulse/index-core/concurrency.ts';
import { addDays } from '@pulse/index-core/dates.ts';
import {
  DISCOVERY_V1,
  discoverTopics,
  selectCandidates,
  type DiscoveryCandidate,
  type DiscoveredTopic,
  type DiscoverySettings,
} from '@pulse/index-core/discovery.ts';
import type { TrendSource } from '@pulse/index-core/trend-epoch.ts';
import { curatedImage } from '../config/topic-images.ts';
import { notesForTopics, type ContextNote } from './summaries.ts';

/** A discovered topic with the fields the page needs but the rules do not own. */
export interface DiscoveryEntry extends DiscoveredTopic {
  /** Article the numbers came from, for a reader to check. */
  readonly link: string;
  /** Lead image, null when the article has no usable thumbnail. */
  readonly imageUrl: string | null;
  /** Generated context sentence, absent when no model was configured or it failed. */
  readonly context?: ContextNote;
  /** Present when the candidate came from the X trend list, not the Wikipedia ranking. */
  readonly via?: 'x';
  /** Pageview sources behind the numbers, so the signed epoch can be checked. */
  readonly sources: readonly TrendSource[];
}

/** The published record for one day of discovery. Display only, never signed. */
export interface DiscoveryRecord {
  readonly day: string;
  readonly generatedAt: string;
  readonly method: 'wikipedia-top-v1';
  readonly settings: DiscoverySettings;
  /** Model that wrote the context notes, null when none were written. */
  readonly contextModel: string | null;
  readonly entries: readonly DiscoveryEntry[];
}

function discoveryPath(snapshotsDir: string, day: string): string {
  return join(snapshotsDir, 'discovery', `${day}.json`);
}

/** Reads the discovery record for one day, or null when it was never built. */
export async function readDiscovery(
  snapshotsDir: string,
  day: string,
): Promise<DiscoveryRecord | null> {
  try {
    const raw = await readFile(discoveryPath(snapshotsDir, day), 'utf8');
    return JSON.parse(raw) as DiscoveryRecord;
  } catch {
    return null;
  }
}

/**
 * Joins each topic with its lead image and, when a model is configured, one
 * sentence of context. Context is optional by design: a build without a key
 * publishes the same numbers with no notes rather than failing.
 */
async function buildEntries(args: {
  readonly topics: readonly DiscoveredTopic[];
  readonly images: readonly (string | null)[];
  readonly day: string;
  readonly summary: ChatConfig | null;
  readonly sourcesByArticle: ReadonlyMap<string, readonly TrendSource[]>;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}): Promise<readonly DiscoveryEntry[]> {
  const notes = args.summary === null
    ? new Map<string, ContextNote>()
    : await notesForTopics({
        topics: args.topics,
        day: args.day,
        config: args.summary,
        ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
        ...(args.log === undefined ? {} : { log: args.log }),
      });
  return args.topics.map((topic, index) => {
    const context = notes.get(topic.article);
    return {
      ...topic,
      link: `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.article)}`,
      imageUrl: args.images[index] ?? curatedImage(topic.article),
      sources: args.sourcesByArticle.get(topic.article) ?? [],
      ...(context === undefined ? {} : { context }),
    };
  });
}

/** Pageview series per candidate. A failing article becomes an empty series. */
async function measureCandidates(
  articles: readonly string[],
  day: string,
  settings: DiscoverySettings,
  now: Date,
  fetchImpl: typeof fetch | undefined,
): Promise<readonly (DiscoveryCandidate & { sources: readonly TrendSource[] })[]> {
  return mapWithConcurrency(articles, 2, async (article) => {
    try {
      const fetched = await fetchPageviews(
        article,
        addDays(day, -settings.baselineWindowDays),
        day,
        { now: () => now, ...(fetchImpl === undefined ? {} : { fetchImpl }) },
      );
      const sources = fetched.urls.map((url) => ({
        url,
        retrievedAt: fetched.retrievedAt,
        payloadSha256: fetched.payloadSha256,
      }));
      return { article, observations: fetched.observations, sources };
    } catch {
      return { article, observations: [], sources: [] };
    }
  });
}

/** Trends resolved per build. The lower half of the list rarely maps to an article. */
const X_CANDIDATE_LIMIT = 12;

/**
 * Resolves the day's X trends to Wikipedia articles.
 *
 * Rank is used only to pick which trends are worth the lookup. Nothing from the
 * X response is published as a number: the resolved articles go through the same
 * pageview measurement as the rest of discovery.
 */
async function xCandidates(
  args: {
    readonly xApiKey?: string | null;
    readonly fetchImpl?: typeof fetch;
    readonly log?: (line: string) => void;
  },
  basketArticles: ReadonlySet<string>,
): Promise<readonly string[]> {
  const key = args.xApiKey === undefined ? xTrendsKey() : args.xApiKey;
  if (key === null) {
    return [];
  }
  try {
    const lists: Awaited<ReturnType<typeof fetchXTrends>>[] = [];
    for (const [index, woeid] of X_TRENDS_WOEIDS.entries()) {
      if (index > 0) {
        // One request every five seconds on the free tier, so the lists are
        // read in sequence rather than as a burst.
        await new Promise((resolve) => setTimeout(resolve, 5500));
      }
      lists.push(
        await fetchXTrends({
          apiKey: key,
          woeid,
          ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
        }),
      );
    }
    // The same phrase can rank in both lists, so names are merged on their best
    // rank before anything is resolved.
    const byName = new Map<string, { name: string; rank: number }>();
    for (const list of lists) {
      for (const trend of list.trends) {
        const current = byName.get(trend.name.toLowerCase());
        if (current === undefined || trend.rank < current.rank) {
          byName.set(trend.name.toLowerCase(), trend);
        }
      }
    }
    const ranked = [...byName.values()].sort((a, b) => a.rank - b.rank);
    const resolved = await mapWithConcurrency(
      ranked.slice(0, X_CANDIDATE_LIMIT),
      2,
      (trend) =>
        resolveTrendArticle(
          trend.name,
          args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl },
        ),
    );
    const articles: string[] = [];
    for (const article of resolved) {
      if (article === null) continue;
      if (basketArticles.has(article) || articles.includes(article)) continue;
      articles.push(article);
    }
    args.log?.(`x trends: ${ranked.length} listed, ${articles.length} resolved`);
    return articles;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    args.log?.(`x trends skipped: ${detail}`);
    return [];
  }
}

/**
 * Finds what trended that day outside the basket and caches the result.
 *
 * Runs at build time, not per request: the page stays a static artifact and a
 * reader never waits on Wikipedia. A candidate that fails is dropped rather than
 * failing the day, because discovery is presentation and the signed epoch has
 * already been published by the time this runs.
 */
export async function refreshDiscovery(args: {
  readonly day: string;
  readonly basket: readonly EntityDefinition[];
  readonly snapshotsDir: string;
  readonly now?: Date;
  readonly settings?: DiscoverySettings;
  readonly summary?: ChatConfig | null;
  /** Overrides the env key; null disables the X trend list. */
  readonly xApiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}): Promise<DiscoveryRecord> {
  const settings = args.settings ?? DISCOVERY_V1;
  const now = args.now ?? new Date();
  const top = await fetchTopArticles(args.day, {
    now: () => now,
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
  });
  const basketArticles = new Set(args.basket.map((entity) => entity.wikipediaArticle));

  // The X list is a second way in for topics the Wikipedia ranking did not put
  // near the top. Without a key it is skipped silently: discovery is optional
  // and must never hold up a signed epoch.
  const xArticles = await xCandidates(args, basketArticles);
  const candidates = [
    ...selectCandidates(
      top.articles,
      basketArticles,
      settings.candidateLimit,
      settings.excludedTopicPrefixes,
    ),
    ...xArticles,
  ].filter((article, index, all) => all.indexOf(article) === index);

  const measured = await measureCandidates(candidates, args.day, settings, now, args.fetchImpl);

  const sourcesByArticle = new Map(measured.map((entry) => [entry.article, entry.sources]));
  const topics = discoverTopics(measured, args.day, settings);
  const images = await mapWithConcurrency(topics, 2, (topic) => fetchArticleImage(topic.article));

  const summary = args.summary === undefined ? chatConfigFromEnv() : args.summary;
  const built = await buildEntries({
    topics,
    images,
    day: args.day,
    summary,
    sourcesByArticle,
    ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
    ...(args.log === undefined ? {} : { log: args.log }),
  });
  const fromX = new Set(xArticles);
  const entries = built.map((entry) =>
    fromX.has(entry.article) ? { ...entry, via: 'x' as const } : entry,
  );

  const record: DiscoveryRecord = {
    day: args.day,
    generatedAt: now.toISOString(),
    method: 'wikipedia-top-v1',
    settings,
    contextModel: summary === null ? null : summary.model,
    entries,
  };

  const path = discoveryPath(args.snapshotsDir, args.day);
  await mkdir(join(args.snapshotsDir, 'discovery'), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2));
  return record;
}
