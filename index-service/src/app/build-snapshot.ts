import type { EntityDefinition } from '../config/entities.ts';
import { INDEX_DEFINITION_ID } from '../config/index-definition.ts';
import { SIGNALS, type SeriesFetch, type SignalDefinition } from '../config/signals.ts';
import { mapWithConcurrency } from '../domain/concurrency.ts';
import { summarizeCoverage } from '../domain/coverage.ts';
import { addDays } from '../domain/dates.ts';
import { MOMENTUM_WINDOW_DAYS, momentumFrom, type Momentum } from '../domain/momentum.ts';
import {
  aggregateIndex,
  combineIndices,
  scoreEntity,
  type EntityScore,
  type IndexAggregate,
} from '../domain/scoring.ts';
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
  /**
   * Earlier published snapshots, consulted only to measure momentum.
   *
   * Momentum is the change in a published number, so recomputing it from raw
   * sources would make it a different metric. History is optional: an epoch
   * without a reference snapshot publishes null momentum rather than a guess.
   */
  readonly history?: readonly IndexSnapshot[];
}

/**
 * Fetches every entity-series pair for every signal with bounded concurrency.
 *
 * The basket is 7 entities across 2 signals, and done serially the build spends
 * minutes waiting on round trips. The ceiling stays low because these are free
 * public APIs that throttle bursts, and each series is one request (pageviews)
 * or one request per day (Hacker News), so the in-flight count is the outer
 * limit times the adapter's own.
 */
async function fetchAll(
  input: BuildSnapshotInput,
  signals: readonly SignalDefinition[],
): Promise<readonly SeriesFetch[]> {
  const tasks = signals.flatMap((signal) => input.entities.map((entity) => ({ signal, entity })));
  return mapWithConcurrency(tasks, input.concurrency ?? 2, async ({ signal, entity }) => {
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
  });
}

/** Published index for one signal in the reference snapshot, if it scored. */
function priorScore(
  reference: IndexSnapshot | null,
  seriesId: string | null,
): IndexAggregate | null {
  if (reference === null) {
    return null;
  }
  if (seriesId === null) {
    return reference.index;
  }
  return reference.series.find((entry) => entry.id === seriesId)?.index ?? null;
}

function momentumFor(
  reference: IndexSnapshot | null,
  seriesId: string | null,
  referenceDay: string,
  current: IndexAggregate,
): Momentum | null {
  const prior = priorScore(reference, seriesId);
  return momentumFrom(current.score, prior?.score ?? null, referenceDay);
}

/**
 * Builds one epoch snapshot from a fixed basket across every configured signal.
 *
 * A source that fails aborts the build instead of publishing a partial index,
 * so an epoch always describes the full definition it names.
 */
export async function buildSnapshot(input: BuildSnapshotInput): Promise<IndexSnapshot> {
  const signals = input.signals ?? SIGNALS;
  const fetched = await fetchAll(input, signals);

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
      momentum: null,
      entities,
    };
    return { entry, records };
  });

  const sources = built.flatMap((item) => item.records);
  const index = combineIndices(built.map((item) => item.entry.index));
  const referenceDay = addDays(input.targetDay, -MOMENTUM_WINDOW_DAYS);
  const reference = input.history?.find((entry) => entry.epochDay === referenceDay) ?? null;
  const series = built.map((item) => ({
    ...item.entry,
    momentum: momentumFor(reference, item.entry.id, referenceDay, item.entry.index),
  }));

  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: input.targetDay,
    generatedAt: input.now.toISOString(),
    definitionId: INDEX_DEFINITION_ID,
    index,
    momentum: momentumFor(reference, null, referenceDay, index),
    coverage: summarizeCoverage(series, sources),
    series,
    sources,
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
