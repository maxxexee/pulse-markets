import { mapWithConcurrency } from '../domain/concurrency.ts';
import type { DailyObservation } from '../domain/observation.ts';
import { sha256Hex } from '../domain/snapshot.ts';
import { WikipediaError, fetchPageviews } from './wikipedia-pageviews.ts';

/** Languages fetched at once: one page per edition, and Wikimedia throttles bursts. */
const PROJECT_CONCURRENCY = 4;

/** One constituent's summed pageviews, with the provenance needed to audit them. */
export interface GlobalPageviewsFetch {
  readonly urls: readonly string[];
  readonly retrievedAt: string;
  readonly payloadSha256: string;
  readonly observations: readonly DailyObservation[];
}

/**
 * Sums daily pageviews for one entity across the editions its titles name.
 *
 * Each edition is a separate public URL, so a stranger can refetch every page
 * that produced the total. Days are summed rather than averaged: the number is
 * readership across the listed editions, not an index over them. A day missing
 * from one edition contributes nothing, which is what a day with no views is.
 */
export async function fetchGlobalPageviews(
  titles: Readonly<Record<string, string>>,
  startDay: string,
  endDay: string,
  options: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<GlobalPageviewsFetch> {
  const projects = Object.entries(titles).sort(([left], [right]) => left.localeCompare(right));
  if (projects.length === 0) {
    throw new WikipediaError(
      'request-failed',
      'no per-language titles in the definition for this constituent',
    );
  }

  const pages = await mapWithConcurrency(projects, PROJECT_CONCURRENCY, async ([language, title]) => {
    try {
      return await fetchPageviews(title, startDay, endDay, {
        project: `${language}.wikipedia`,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new WikipediaError('request-failed', `${language}: ${detail}`);
    }
  });

  const urls: string[] = [];
  const bodies: string[] = [];
  const totals = new Map<string, number>();
  for (const page of pages) {
    urls.push(...page.urls);
    bodies.push(page.body);
    for (const observation of page.observations) {
      totals.set(observation.day, (totals.get(observation.day) ?? 0) + observation.value);
    }
  }

  const now = options.now?.() ?? new Date();
  return {
    urls,
    retrievedAt: now.toISOString(),
    payloadSha256: sha256Hex(bodies.join('\n')),
    observations: [...totals.entries()]
      .map(([day, value]) => ({ day, value }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}
