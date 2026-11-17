import type { DailyObservation } from './observation.ts';
import type { TopArticle } from '../adapters/wikipedia-top.ts';

/**
 * Rules for promoting a naturally trending article out of the daily Wikipedia
 * ranking and onto the page.
 *
 * The ranking alone says what was read, not what changed. A topic only appears
 * if it clears all three bars, so an evergreen page with a huge but flat
 * audience stays off the list and a one-day blip without real reach does too.
 */
export interface DiscoverySettings {
  /** Articles from the top of the ranking that are worth the extra requests. */
  readonly candidateLimit: number;
  /** Days of history averaged into the baseline. */
  readonly baselineWindowDays: number;
  /** Below this many baseline days the comparison is not published. */
  readonly minBaselineDays: number;
  /** A baseline this small cannot support a percentage. */
  readonly minBaselineViews: number;
  /** Views on the discovery day itself. */
  readonly minViews: number;
  /** Percent above baseline required to count as trending. */
  readonly minMomentum: number;
  /** Cards the page gets at most. */
  readonly maxResults: number;
  /**
   * Editorial gate for standing pages whose traffic is real but not a topic:
   * list pages and annual roundups trend by design and crowd out actual news.
   */
  readonly excludedTopicPrefixes: readonly string[];
}

export const DISCOVERY_V1: DiscoverySettings = {
  candidateLimit: 24,
  baselineWindowDays: 7,
  minBaselineDays: 3,
  minBaselineViews: 1000,
  minViews: 20000,
  minMomentum: 100,
  maxResults: 6,
  excludedTopicPrefixes: ['List_of_', 'Lists_of_', 'Deaths_in_', 'Timeline_of_', 'Index_of_'],
};

export interface DiscoveryCandidate {
  readonly article: string;
  readonly observations: readonly DailyObservation[];
}

/** A trend the ranking surfaced, with the numbers that justified showing it. */
export interface DiscoveredTopic {
  readonly article: string;
  /** Article title with spaces, for display. */
  readonly topic: string;
  /** Views on the discovery day. */
  readonly views: number;
  /** Mean daily views over the baseline window. */
  readonly baseline: number;
  /** Baseline days actually used. */
  readonly baselineDays: number;
  /** Percent change from baseline to the discovery day, one decimal. */
  readonly momentum: number;
}

export function topicLabel(article: string): string {
  return article.replaceAll('_', ' ').trim();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Picks the articles to measure: the biggest readers of the day that the signed
 * basket does not already cover. Ranking order is by views, because discovery is
 * about reach first and change second.
 */
export function selectCandidates(
  articles: readonly TopArticle[],
  basketArticles: ReadonlySet<string>,
  limit: number,
  excludedPrefixes: readonly string[] = DISCOVERY_V1.excludedTopicPrefixes,
): readonly string[] {
  return articles
    .filter((entry) => !basketArticles.has(entry.article))
    .filter((entry) => !excludedPrefixes.some((prefix) => entry.article.startsWith(prefix)))
    .sort((a, b) => b.views - a.views)
    .slice(0, limit)
    .map((entry) => entry.article);
}

/** Views for one day, or null when the series has no entry for it. */
function valueOn(observations: readonly DailyObservation[], day: string): number | null {
  const match = observations.find((entry) => entry.day === day);
  return match === undefined ? null : match.value;
}

/**
 * Applies the thresholds and returns the surviving topics, biggest change first.
 *
 * Momentum is the discovery day's views against the mean of the preceding days,
 * which is a different comparison from the signed index (score levels over a
 * published epoch). It is kept in its own artifact and never mixes into the
 * index numbers.
 */
export function discoverTopics(
  candidates: readonly DiscoveryCandidate[],
  day: string,
  settings: DiscoverySettings = DISCOVERY_V1,
): readonly DiscoveredTopic[] {
  const found: DiscoveredTopic[] = [];
  for (const candidate of candidates) {
    const views = valueOn(candidate.observations, day);
    if (views === null || views < settings.minViews) {
      continue;
    }
    const prior = candidate.observations
      .filter((entry) => entry.day < day)
      .slice(-settings.baselineWindowDays);
    if (prior.length < settings.minBaselineDays) {
      continue;
    }
    const baseline = prior.reduce((total, entry) => total + entry.value, 0) / prior.length;
    if (baseline < settings.minBaselineViews) {
      continue;
    }
    const momentum = round1(((views - baseline) / baseline) * 100);
    if (momentum < settings.minMomentum) {
      continue;
    }
    found.push({
      article: candidate.article,
      topic: topicLabel(candidate.article),
      views,
      baseline: Math.round(baseline),
      baselineDays: prior.length,
      momentum,
    });
  }
  return found.sort((a, b) => b.momentum - a.momentum).slice(0, settings.maxResults);
}
