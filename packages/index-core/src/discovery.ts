import type { DailyObservation } from './observation.ts';

/** One entry of the daily Wikipedia ranking, before any rule is applied. */
export interface TopArticle {
  readonly article: string;
  readonly views: number;
  readonly rank: number;
}

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
  /** Pages collapsed into this one because they told the same story. */
  readonly alsoRanked?: readonly string[];
}

/** Suffixes for pages that detail a work or list about the same subject. */
const DERIVATIVE_SUFFIX =
  /\s+(filmography|discography|videography|bibliography|film series|television series|awards and nominations)$/i;

/**
 * Generational suffixes that trail a name without being the surname. Without
 * stripping them, every "... Jr." page would key on the suffix and collapse
 * people who share nothing but a middle name convention.
 */
const GENERATIONAL_SUFFIX = /\s+(?:jr\.?|sr\.?|ii|iii|iv)$/i;

/** Two or three capitalised words and nothing else, the shape of a person's name. */
const PERSON_NAME = /^\p{Lu}[\p{L}'’.\-]*(?: \p{Lu}[\p{L}'’.\-]*){1,2}$/u;

export function topicLabel(article: string): string {
  return article.replaceAll('_', ' ').trim();
}

/**
 * Key for pages that are one story to a reader: an article and its filmography,
 * or two people sharing a surname. The ranking counts each page separately, so
 * a single news day can otherwise fill the strip with one family.
 *
 * The test is structural, not a claim about the subject. Two unrelated people
 * with the same surname on the same day would be merged, which hides the lower
 * ranked one; that is the accepted cost of dropping the visible duplicates.
 */
export function storyKey(article: string): string {
  const title = article.replace(/\([^)]*\)\s*$/, '').replaceAll('_', ' ').trim();
  const base = title.replace(DERIVATIVE_SUFFIX, '').replace(GENERATIONAL_SUFFIX, '').trim();
  if (!PERSON_NAME.test(base)) {
    return `page:${base.toLowerCase()}`;
  }
  const surname = base.split(' ').at(-1) ?? base;
  return `surname:${surname.toLowerCase()}`;
}

/**
 * Keeps the most read page of each story and records what it absorbed. Runs
 * before the result cap so one family cannot take several cards.
 */
export function collapseStories(topics: readonly DiscoveredTopic[]): readonly DiscoveredTopic[] {
  const kept = new Map<string, DiscoveredTopic>();
  const dropped = new Map<string, string[]>();
  for (const topic of topics) {
    const key = storyKey(topic.article);
    const current = kept.get(key);
    if (current === undefined) {
      kept.set(key, topic);
      continue;
    }
    const [winner, loser] = current.views >= topic.views ? [current, topic] : [topic, current];
    kept.set(key, winner);
    dropped.set(key, [...(dropped.get(key) ?? []), topicLabel(loser.article)]);
  }
  return [...kept].map(([key, topic]) => {
    const absorbed = dropped.get(key);
    return absorbed === undefined ? topic : { ...topic, alsoRanked: absorbed };
  });
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
/**
 * A candidate the rules dropped, and the measurement that dropped it.
 *
 * Kept because the negatives are the part of the record nobody else can
 * reproduce: a settled NO is only checkable if it says what it was holding.
 */
export interface DiscoveryRejection {
  readonly article: string;
  readonly topic: string;
  readonly reason:
    | 'no-views'
    | 'views-below-floor'
    | 'too-few-baseline-days'
    | 'baseline-below-floor'
    | 'momentum-below-floor';
  readonly views: number | null;
  readonly baseline: number | null;
  readonly baselineDays: number;
  readonly momentum: number | null;
}

type Assessment =
  | { readonly topic: DiscoveredTopic }
  | { readonly rejection: DiscoveryRejection };

/** One candidate through the three bars, returning why it failed when it did. */
function assess(
  candidate: DiscoveryCandidate,
  day: string,
  settings: DiscoverySettings,
): Assessment {
  const reason = (
    why: DiscoveryRejection['reason'],
    numbers: { views: number | null; baseline: number | null; baselineDays: number; momentum: number | null },
  ): Assessment => ({
    rejection: {
      article: candidate.article,
      topic: topicLabel(candidate.article),
      reason: why,
      ...numbers,
    },
  });
  const views = valueOn(candidate.observations, day);
  if (views === null) {
    return reason('no-views', { views: null, baseline: null, baselineDays: 0, momentum: null });
  }
  const prior = candidate.observations
    .filter((entry) => entry.day < day)
    .slice(-settings.baselineWindowDays);
  const baseline =
    prior.length === 0 ? null : prior.reduce((total, entry) => total + entry.value, 0) / prior.length;
  const shared = {
    views,
    baseline: baseline === null ? null : Math.round(baseline),
    baselineDays: prior.length,
  };
  if (views < settings.minViews) {
    return reason('views-below-floor', { ...shared, momentum: null });
  }
  if (prior.length < settings.minBaselineDays) {
    return reason('too-few-baseline-days', { ...shared, momentum: null });
  }
  const momentum = round1(((views - (baseline ?? 0)) / (baseline ?? 1)) * 100);
  if ((baseline ?? 0) < settings.minBaselineViews) {
    return reason('baseline-below-floor', { ...shared, momentum });
  }
  if (momentum < settings.minMomentum) {
    return reason('momentum-below-floor', { ...shared, momentum });
  }
  return {
    topic: {
      article: candidate.article,
      topic: topicLabel(candidate.article),
      views,
      baseline: Math.round(baseline ?? 0),
      baselineDays: prior.length,
      momentum,
    },
  };
}

/**
 * Candidates that cleared every bar, biggest change first.
 *
 * Order matters for settlement: the cap and the story collapse both drop topics
 * that passed the thresholds, so they are applied here and nowhere else.
 */
export function discoverTopics(
  candidates: readonly DiscoveryCandidate[],
  day: string,
  settings: DiscoverySettings = DISCOVERY_V1,
): readonly DiscoveredTopic[] {
  const found: DiscoveredTopic[] = [];
  for (const candidate of candidates) {
    const assessed = assess(candidate, day, settings);
    if ('topic' in assessed) {
      found.push(assessed.topic);
    }
  }
  const ranked = found.sort((a, b) => b.momentum - a.momentum);
  return [...collapseStories(ranked)]
    .sort((a, b) => b.momentum - a.momentum)
    .slice(0, settings.maxResults);
}

/**
 * The candidates the thresholds dropped, in ranking order.
 *
 * Topics dropped by the result cap after passing every threshold are not here:
 * they qualified and did not make the page, which is a different statement from
 * failing the rule, and a NO resolution should not conflate the two.
 */
export function rejectedCandidates(
  candidates: readonly DiscoveryCandidate[],
  day: string,
  settings: DiscoverySettings = DISCOVERY_V1,
): readonly DiscoveryRejection[] {
  const rejected: DiscoveryRejection[] = [];
  for (const candidate of candidates) {
    const assessed = assess(candidate, day, settings);
    if ('rejection' in assessed) {
      rejected.push(assessed.rejection);
    }
  }
  return rejected;
}
