import type { EntityDefinition } from '../config/entities.ts';
import { SIGNALS, type SeriesFetch, type SignalDefinition } from '../config/signals.ts';
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
}

/**
 * Builds one epoch snapshot from a fixed basket across every configured signal.
 *
 * Fetches run one at a time rather than in parallel. The work is small enough
 * that speed does not matter, and serial requests keep the index a polite
 * consumer of free public APIs that throttle bursts.
 */
export async function buildSnapshot(input: BuildSnapshotInput): Promise<IndexSnapshot> {
  const signals = input.signals ?? SIGNALS;
  const series: SignalSeries[] = [];
  const sources: SourceRecord[] = [];

  for (const signal of signals) {
    const startDay = addDays(input.targetDay, -signal.scoring.baselineWindowDays);
    const entities: EntityScore[] = [];
    for (const entity of input.entities) {
      const fetched = await signal.fetchSeries(entity, startDay, input.targetDay);
      entities.push(scoreEntity(entity.id, fetched.observations, input.targetDay, signal.scoring));
      sources.push(toSourceRecord(signal.id, entity.id, fetched));
    }
    series.push({
      id: signal.id,
      label: signal.label,
      unit: signal.unit,
      scoring: signal.scoring,
      index: aggregateIndex(entities),
      entities,
    });
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: input.targetDay,
    generatedAt: input.now.toISOString(),
    index: combineIndices(series.map((entry) => entry.index)),
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
