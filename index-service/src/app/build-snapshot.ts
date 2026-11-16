import type { EntityDefinition } from '../config/entities.ts';
import { SIGNALS, type SeriesFetch, type SignalDefinition } from '../config/signals.ts';
import { mapWithConcurrency } from '../domain/concurrency.ts';
import { addDays } from '../domain/dates.ts';
import { aggregateIndex, combineIndices, scoreEntity, type EntityScore } from '../domain/scoring.ts';
import {
  SNAPSHOT_SCHEMA,
  type IndexSnapshot,
  type SignalSeries,
  type SourceRecord,
} from '../domain/snapshot.ts';

export interface BuildSnapshotInput {
  readonly entities: readonly EntityDefinition[];
  /** UTC day the index describes; must be a complete day. */
  readonly targetDay: string;
  readonly now: Date;
  /** Signal set to score. Defaults to the published set. */
  readonly signals?: readonly SignalDefinition[];
  /** Entity-series fetches allowed in flight at once. Defaults to 2. */
  readonly concurrency?: number;
}

/**
 * Builds one epoch snapshot from a fixed basket across every configured signal.
 *
 * Entity-series fetches run with bounded concurrency instead of one after
 * another: the basket is 7 entities across 2 signals, and done serially the
 * build spends minutes waiting on round trips. The ceiling stays low because
 * these are free public APIs that throttle bursts, and each series is one
 * request (pageviews) or one request per day (Hacker News), so the in-flight
 * count is the outer limit times the adapter's own.
 */
export async function buildSnapshot(input: BuildSnapshotInput): Promise<IndexSnapshot> {
  const signals = input.signals ?? SIGNALS;
  const tasks = signals.flatMap((signal) =>
    input.entities.map((entity) => ({ signal, entity })),
  );
  const fetched = await mapWithConcurrency(
    tasks,
    input.concurrency ?? 2,
    async ({ signal, entity }) => {
      try {
        return await signal.fetchSeries(
          entity,
          addDays(input.targetDay, -signal.scoring.baselineWindowDays),
          input.targetDay,
        );
      } catch (error) {
        // Name the failing source: a bare "fetch failed" does not say which of
        // the signals or entities needs attention.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${signal.id}/${entity.id}: ${detail}`, { cause: error });
      }
    },
  );

  const built = signals.map((signal, signalIndex) => {
    const entities: EntityScore[] = [];
    const records: SourceRecord[] = [];
    input.entities.forEach((entity, entityIndex) => {
      const series = fetched[signalIndex * input.entities.length + entityIndex];
      if (series === undefined) {
        throw new Error(`missing ${signal.id} fetch for ${entity.id}`);
      }
      entities.push(scoreEntity(entity.id, series.observations, input.targetDay, signal.scoring));
      records.push(toSourceRecord(signal.id, entity.id, series));
    });
    const entry: SignalSeries = {
      id: signal.id,
      label: signal.label,
      unit: signal.unit,
      scoring: signal.scoring,
      index: aggregateIndex(entities),
      entities,
    };
    return { entry, records };
  });

  const series = built.map((item) => item.entry);
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: input.targetDay,
    generatedAt: input.now.toISOString(),
    index: combineIndices(series.map((entry) => entry.index)),
    series,
    sources: built.flatMap((item) => item.records),
  };
}

function toSourceRecord(
  signalId: string,
  entityId: string,
  fetched: SeriesFetch,
): SourceRecord {
  const observations = fetched.observations;
  return {
    entityId,
    signal: signalId,
    urls: fetched.urls,
    retrievedAt: fetched.retrievedAt,
    payloadSha256: fetched.payloadSha256,
    observations: observations.length,
    firstDay: observations[0]?.day ?? null,
    lastDay: observations[observations.length - 1]?.day ?? null,
  };
}
