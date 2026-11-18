import type { SignalSeries, SourceRecord } from './snapshot.ts';

/**
 * How much of the expected input actually scored, published beside the index.
 *
 * The score and the confidence are separate on purpose: a 71 computed from 2 of
 * 14 series and a 71 computed from 14 of 14 are not the same claim, and a reader
 * has to be able to tell them apart without reading the provenance table.
 */
export interface Coverage {
  readonly signalsScored: number;
  readonly signalsTotal: number;
  readonly seriesScored: number;
  readonly seriesExpected: number;
  /** Series scored divided by series expected, 0 to 1, four decimal places. */
  readonly confidence: number;
  /**
   * Share of the headline weight that actually scored, 0 to 1.
   *
   * A series count says how many series answered; this says how much of the
   * index they represent. The two differ because constituents carry different
   * weights, and a reader needs both to know what a level is made of.
   */
  readonly weightScored: number;
  /** Earliest retrieval time across every source record, or null when none. */
  readonly oldestSourceAt: string | null;
}

/**
 * Coverage below which an epoch is not published at all.
 *
 * An epoch is signed evidence and cannot be edited afterwards, so a day read
 * from a fragment of the basket must not become permanent: a build that runs
 * before a source has posted its daily figure would otherwise sign a snapshot
 * that no market could settle against. Matches the resolver's default market
 * floor, so nothing is published that could never be used to settle.
 */
export const MIN_PUBLISH_CONFIDENCE = 0.5;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Summarises coverage from the built series and their provenance records.
 *
 * A series is one signal for one entity. Counting series rather than entities
 * means a signal that half-failed cannot look complete.
 */
export function summarizeCoverage(
  series: readonly SignalSeries[],
  sources: readonly SourceRecord[],
  weightScored: number,
): Coverage {
  const seriesScored = series.reduce((total, entry) => total + entry.index.scoredEntities, 0);
  const seriesExpected = series.reduce((total, entry) => total + entry.index.totalEntities, 0);
  const retrieved = sources
    .map((record) => record.retrievedAt)
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort();
  return {
    signalsScored: series.filter((entry) => entry.index.score !== null).length,
    signalsTotal: series.length,
    seriesScored,
    seriesExpected,
    confidence: seriesExpected === 0 ? 0 : round4(seriesScored / seriesExpected),
    weightScored: round4(weightScored),
    oldestSourceAt: retrieved[0] ?? null,
  };
}
