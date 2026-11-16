/**
 * One UTC day of attention volume recorded for an entity.
 *
 * Observations are the raw, independently refetchable inputs to the index. A
 * snapshot is only trustworthy if every observation it uses can be re-derived
 * from its recorded source URL.
 */
export interface DailyObservation {
  /** UTC calendar day, formatted YYYY-MM-DD. */
  readonly day: string;
  /** Views or mentions recorded for that day. */
  readonly views: number;
}
