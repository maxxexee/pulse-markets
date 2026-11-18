import { fetchMentions } from '../adapters/hacker-news.ts';
import { fetchTitles } from '../adapters/wikimedia-titles.ts';
import { fetchPageviews } from '../adapters/wikipedia-pageviews.ts';
import { fetchGlobalPageviews } from '../adapters/wikipedia-global.ts';
import type { DailyObservation } from '../domain/observation.ts';
import {
  PULSE_SCORING_COUNTS_V1,
  PULSE_SCORING_V1,
  type ScoringConfig,
} from '../domain/scoring.ts';
import type { EntityDefinition } from './entities.ts';

/** Raw observations plus provenance, as returned by every source adapter. */
export interface SeriesFetch {
  readonly urls: readonly string[];
  readonly retrievedAt: string;
  readonly payloadSha256: string;
  readonly observations: readonly DailyObservation[];
}

/**
 * One attention source, scored with its own formula.
 *
 * Signals are kept separate rather than pre-mixed so each published number has
 * exactly one definition and one set of source URLs behind it.
 */
export interface SignalDefinition {
  readonly id: string;
  readonly label: string;
  /** Unit of the raw counts, for display. */
  readonly unit: string;
  /**
   * Policy weight of this signal inside the headline index, 0 to 1, summing to 1
   * across the published signals.
   *
   * Pageviews carry most of the weight because they are dense, arrive for every
   * entity every day, and are filtered for automated traffic upstream. Story
   * counts are sparse, gated at a handful of items, and skewed to one audience,
   * so they inform the index rather than set its level.
   */
  readonly weight: number;
  readonly scoring: ScoringConfig;
  fetchSeries(
    entity: EntityDefinition,
    startDay: string,
    endDay: string,
    context?: SeriesContext,
  ): Promise<SeriesFetch>;
  /**
   * Resolves the per-edition article titles a signal reads, during calibration.
   *
   * Only signals that read more than one wiki need this. The result is frozen
   * into the definition, so builds and verification read exactly the pages the
   * published terms name instead of asking Wikidata again.
   */
  resolveTitles?(entity: EntityDefinition): Promise<Record<string, string>>;
}

/** Published constituent data a build hands to its signal. */
export interface SeriesContext {
  readonly titles?: Readonly<Record<string, string>>;
}

/**
 * The published basket of signals, in fixed order.
 *
 * Adding a signal changes the headline index, so it is an index version change,
 * not a configuration tweak.
 */
export const SIGNALS: readonly SignalDefinition[] = [
  {
    id: 'wikipedia-pageviews',
    label: 'Wikipedia pageviews, English',
    unit: 'views',
    weight: 0.6,
    scoring: PULSE_SCORING_V1,
    fetchSeries: (entity, startDay, endDay) =>
      fetchPageviews(entity.wikipediaArticle, startDay, endDay),
  },
  {
    id: 'wikipedia-pageviews-global',
    label: 'Wikipedia pageviews, non-English',
    unit: 'views',
    weight: 0.15,
    scoring: PULSE_SCORING_V1,
    fetchSeries: (entity, startDay, endDay, context) =>
      fetchGlobalPageviews(context?.titles ?? {}, startDay, endDay),
    resolveTitles: (entity) => fetchTitles(entity.wikipediaArticle),
  },
  {
    id: 'hacker-news-stories',
    label: 'Hacker News stories',
    unit: 'stories',
    weight: 0.25,
    scoring: PULSE_SCORING_COUNTS_V1,
    fetchSeries: (entity, startDay, endDay) =>
      fetchMentions(entity.hackerNewsQuery, startDay, endDay),
  },
];
