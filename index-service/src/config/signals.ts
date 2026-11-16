import { fetchMentions } from '../adapters/hacker-news.ts';
import { fetchPageviews } from '../adapters/wikipedia-pageviews.ts';
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
  readonly scoring: ScoringConfig;
  fetchSeries(
    entity: EntityDefinition,
    startDay: string,
    endDay: string,
  ): Promise<SeriesFetch>;
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
    label: 'Wikipedia pageviews',
    unit: 'views',
    scoring: PULSE_SCORING_V1,
    fetchSeries: (entity, startDay, endDay) =>
      fetchPageviews(entity.wikipediaArticle, startDay, endDay),
  },
  {
    id: 'hacker-news-stories',
    label: 'Hacker News stories',
    unit: 'stories',
    scoring: PULSE_SCORING_COUNTS_V1,
    fetchSeries: (entity, startDay, endDay) =>
      fetchMentions(entity.hackerNewsQuery, startDay, endDay),
  },
];
