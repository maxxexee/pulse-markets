import type { EntityDefinition } from '../config/entities.ts';
import type { PageviewsFetch } from '../adapters/wikipedia-pageviews.ts';
import { addDays } from '../domain/dates.ts';
import {
  PULSE_SCORING_V1,
  aggregateIndex,
  scoreEntity,
  type EntityScore,
  type ScoringConfig,
} from '../domain/scoring.ts';
import { SNAPSHOT_SCHEMA, type IndexSnapshot, type SourceRecord } from '../domain/snapshot.ts';

/** Fetches one entity's raw observations for an inclusive day range. */
export type EntityFetcher = (
  entity: EntityDefinition,
  startDay: string,
  endDay: string,
) => Promise<PageviewsFetch>;

export interface BuildSnapshotInput {
  readonly entities: readonly EntityDefinition[];
  /** UTC day the index describes; must be a complete day. */
  readonly targetDay: string;
  readonly fetchEntity: EntityFetcher;
  readonly now: Date;
  readonly scoring?: ScoringConfig;
}

/**
 * Builds one epoch snapshot from a fixed basket.
 *
 * Entities are fetched one at a time rather than in parallel. The basket is
 * small, and serial requests keep the index a polite consumer of a free public
 * API that throttles bursts.
 */
export async function buildSnapshot(input: BuildSnapshotInput): Promise<IndexSnapshot> {
  const scoring = input.scoring ?? PULSE_SCORING_V1;
  const startDay = addDays(input.targetDay, -scoring.baselineWindowDays);
  const entities: EntityScore[] = [];
  const sources: SourceRecord[] = [];

  for (const entity of input.entities) {
    const fetched = await input.fetchEntity(entity, startDay, input.targetDay);
    entities.push(scoreEntity(entity.id, fetched.observations, input.targetDay, scoring));
    sources.push(toSourceRecord(entity.id, fetched));
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: input.targetDay,
    generatedAt: input.now.toISOString(),
    index: aggregateIndex(entities),
    scoring,
    entities,
    sources,
  };
}

function toSourceRecord(entityId: string, fetched: PageviewsFetch): SourceRecord {
  const observations = fetched.observations;
  return {
    entityId,
    url: fetched.url,
    retrievedAt: fetched.retrievedAt,
    payloadSha256: fetched.payloadSha256,
    observations: observations.length,
    firstDay: observations[0]?.day ?? null,
    lastDay: observations[observations.length - 1]?.day ?? null,
  };
}
