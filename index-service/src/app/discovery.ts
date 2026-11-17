import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchPageviews } from '../adapters/wikipedia-pageviews.ts';
import { fetchArticleImage, fetchTopArticles } from '../adapters/wikipedia-top.ts';
import type { EntityDefinition } from '../config/entities.ts';
import { mapWithConcurrency } from '../domain/concurrency.ts';
import { addDays } from '../domain/dates.ts';
import {
  DISCOVERY_V1,
  discoverTopics,
  selectCandidates,
  type DiscoveredTopic,
  type DiscoverySettings,
} from '../domain/discovery.ts';

/** A discovered topic with the two fields the page needs but the rules do not own. */
export interface DiscoveryEntry extends DiscoveredTopic {
  /** Article the numbers came from, for a reader to check. */
  readonly link: string;
  /** Lead image, null when the article has no usable thumbnail. */
  readonly imageUrl: string | null;
}

/** The published record for one day of discovery. Display only, never signed. */
export interface DiscoveryRecord {
  readonly day: string;
  readonly generatedAt: string;
  readonly method: 'wikipedia-top-v1';
  readonly settings: DiscoverySettings;
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
}): Promise<DiscoveryRecord> {
  const settings = args.settings ?? DISCOVERY_V1;
  const now = args.now ?? new Date();
  const top = await fetchTopArticles(args.day, { now: () => now });
  const basketArticles = new Set(args.basket.map((entity) => entity.wikipediaArticle));
  const candidates = selectCandidates(
    top.articles,
    basketArticles,
    settings.candidateLimit,
    settings.excludedTopicPrefixes,
  );

  const measured = await mapWithConcurrency(candidates, 2, async (article) => {
    try {
      const fetched = await fetchPageviews(
        article,
        addDays(args.day, -settings.baselineWindowDays),
        args.day,
        { now: () => now },
      );
      return { article, observations: fetched.observations };
    } catch {
      return { article, observations: [] };
    }
  });

  const topics = discoverTopics(measured, args.day, settings);
  const images = await mapWithConcurrency(topics, 2, (topic) => fetchArticleImage(topic.article));

  const entries: DiscoveryEntry[] = topics.map((topic, index) => ({
    ...topic,
    link: `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.article)}`,
    imageUrl: images[index] ?? null,
  }));

  const record: DiscoveryRecord = {
    day: args.day,
    generatedAt: now.toISOString(),
    method: 'wikipedia-top-v1',
    settings,
    entries,
  };

  const path = discoveryPath(args.snapshotsDir, args.day);
  await mkdir(join(args.snapshotsDir, 'discovery'), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2));
  return record;
}
