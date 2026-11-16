/**
 * One UTC day of attention volume recorded for an entity.
 *
 * Observations are the raw, independently refetchable inputs to the index. A
 * snapshot is only trustworthy if every observation it uses can be re-derived
 * from its recorded source URLs.
 */
export interface DailyObservation {
  /** UTC calendar day, formatted YYYY-MM-DD. */
  readonly day: string;
  /** Units recorded for that day: pageviews, story mentions, and so on. */
  readonly value: number;
}
