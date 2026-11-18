import type { EntityDefinition } from '../config/entities.ts';
import { SIGNALS, type SeriesFetch, type SignalDefinition } from '../config/signals.ts';
import { mapWithConcurrency } from '../domain/concurrency.ts';
import { summarizeCoverage } from '../domain/coverage.ts';
import { addDays } from '../domain/dates.ts';
import {
  definitionDigest,
  type IndexDefinition,
  type PublishedSignal,
} from '../domain/index-definition.ts';
import { MOMENTUM_WINDOW_DAYS, momentumFrom, type Momentum } from '../domain/momentum.ts';
import {
  round2,
  scoreAgainstAnchor,
  type EntityScore,
  type IndexAggregate,
} from '../domain/scoring.ts';
import {
  SNAPSHOT_SCHEMA,
  type IndexSnapshot,
  type SignalSeries,
  type SourceRecord,
} from '../domain/snapshot.ts';
import { weightedScore } from '../domain/weights.ts';

export interface BuildSnapshotInput {
  readonly entities: readonly EntityDefinition[];
  /** Published definition to compute against. Its anchors and weights are the terms. */
  readonly definition: IndexDefinition;
  /** UTC day the index describes; must be a complete day. */
  readonly targetDay: string;
  readonly now: Date;
  /** Signal set to fetch. Defaults to the published set. */
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

/** Runtime signal definitions keyed by the ids the published definition names. */
function indexSignals(signals: readonly SignalDefinition[]): Map<string, SignalDefinition> {
  return new Map(signals.map((signal) => [signal.id, signal]));
}

/** Runtime entity definitions keyed by the ids the published definition names. */
function indexEntities(entities: readonly EntityDefinition[]): Map<string, EntityDefinition> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

/**
 * Fetches every constituent-series pair for every published signal.
 *
 * The definition decides what is fetched, not the runtime basket, so a snapshot
 * can only ever contain the terms it publishes. The ceiling stays low because
 * these are free public APIs that throttle bursts.
 */
async function fetchAll(
  input: BuildSnapshotInput,
  signals: readonly SignalDefinition[],
): Promise<readonly SeriesFetch[]> {
  const runtimeSignals = indexSignals(signals);
  const entities = indexEntities(input.entities);
  const tasks = input.definition.signals.flatMap((signal) =>
    signal.constituents.map((constituent) => ({
      signal: runtimeSignals.get(signal.id),
      entity: entities.get(constituent.entityId),
      signalId: signal.id,
      entityId: constituent.entityId,
    })),
  );
  return mapWithConcurrency(tasks, input.concurrency ?? 2, async (task) => {
    if (task.signal === undefined || task.entity === undefined) {
      throw new Error(`definition names ${task.signalId}/${task.entityId}, which is not configured`);
    }
    try {
      // Only the target day is measured: the anchor it is compared against came
      // from the published definition, so fetching the calibration window again
      // would be waste and would exceed the source window caps.
      return await task.signal.fetchSeries(task.entity, input.targetDay, input.targetDay);
    } catch (error) {
      // Name the failing source: a bare "fetch failed" does not say which of
      // the signals or entities needs attention.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${task.signalId}/${task.entityId}: ${detail}`, { cause: error });
    }
  });
}

/** Target-day volume for one constituent, or null when the source skipped the day. */
function valueOn(fetched: SeriesFetch, day: string): number | null {
  const match = fetched.observations.find((entry) => entry.day === day);
  return match === undefined ? null : match.value;
}

function scoreSignal(
  published: PublishedSignal,
  fetched: readonly SeriesFetch[],
  definition: IndexDefinition,
  targetDay: string,
): { series: SignalSeries; records: readonly SourceRecord[]; weight: number } {
  const entities: EntityScore[] = published.constituents.map((constituent, position) => {
    const series = fetched[position];
    if (series === undefined) {
      throw new Error(`missing ${published.id}/${constituent.entityId} fetch`);
    }
    return scoreAgainstAnchor(
      constituent.entityId,
      valueOn(series, targetDay),
      constituent.anchor,
      targetDay,
      {
        midpoint: published.scoring.midpoint,
        pointsPerDoubling: published.scoring.pointsPerDoubling,
        minTargetValue: published.scoring.minTargetValue,
        anchorDays: definition.calibrationDays,
      },
    );
  });
  const aggregate = weightedScore(
    published.constituents.map((constituent, position) => ({
      weight: constituent.weight,
      score: entities[position]?.status === 'scored' ? entities[position].score : null,
    })),
  );
  const records = published.constituents.map((constituent, position) => {
    const series = fetched[position];
    if (series === undefined) {
      throw new Error(`missing ${published.id}/${constituent.entityId} fetch`);
    }
    return toSourceRecord(published.id, constituent.entityId, series);
  });
  const series: SignalSeries = {
    id: published.id,
    label: published.label,
    unit: published.unit,
    scoring: published.scoring,
    index: {
      score: aggregate.score === null ? null : round2(aggregate.score),
      scoredEntities: seriesScoredCount(entities),
      totalEntities: entities.length,
    },
    momentum: null,
    entities,
  };
  return { series, records, weight: published.weight };
}

function seriesScoredCount(entities: readonly EntityScore[]): number {
  return entities.filter((entity) => entity.status === 'scored').length;
}

/** Published index for one signal in the reference snapshot, if it scored. */
function priorScore(reference: IndexSnapshot | null, seriesId: string | null): IndexAggregate | null {
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
 * Builds one epoch snapshot from the published definition.
 *
 * Anchors and weights come from the definition, so the same target-day volumes
 * always produce the same level within a definition version. A source that
 * fails aborts the build instead of publishing a partial index.
 */
export async function buildSnapshot(input: BuildSnapshotInput): Promise<IndexSnapshot> {
  const signals = input.signals ?? SIGNALS;
  const fetched = await fetchAll(input, signals);

  const built = [];
  let offset = 0;
  for (const published of input.definition.signals) {
    const slice = fetched.slice(offset, offset + published.constituents.length);
    offset += published.constituents.length;
    built.push(scoreSignal(published, slice, input.definition, input.targetDay));
  }

  const sources = built.flatMap((item) => item.records);
  const headline = weightedScore(
    built.map((item) => ({ weight: item.weight, score: item.series.index.score })),
  );
  const index: IndexAggregate = {
    score: headline.score === null ? null : round2(headline.score),
    scoredEntities: built.reduce((sum, item) => sum + item.series.index.scoredEntities, 0),
    totalEntities: built.reduce((sum, item) => sum + item.series.index.totalEntities, 0),
  };

  const digest = definitionDigest(input.definition);
  const referenceDay = addDays(input.targetDay, -MOMENTUM_WINDOW_DAYS);
  // A delta across two definitions compares different scales, so only a snapshot
  // computed under these exact terms can be a momentum reference.
  const reference =
    input.history?.find(
      (entry) => entry.epochDay === referenceDay && entry.definitionSha256 === digest,
    ) ?? null;
  const series = built.map((item) => ({
    ...item.series,
    momentum: momentumFor(reference, item.series.id, referenceDay, item.series.index),
  }));

  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: input.targetDay,
    generatedAt: input.now.toISOString(),
    definitionId: input.definition.id,
    definition: input.definition,
    definitionSha256: digest,
    index,
    momentum: momentumFor(reference, null, referenceDay, index),
    coverage: summarizeCoverage(series, sources, headline.weightScored),
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
