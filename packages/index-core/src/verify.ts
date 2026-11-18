import { definitionDigest } from './index-definition.ts';
import type { EntityScore } from './scoring.ts';
import type { IndexSnapshot } from './snapshot.ts';

/**
 * One place a recomputed epoch disagrees with the published one.
 *
 * Values are strings for definition-level checks and numbers or null for scores,
 * so a caller prints them without knowing which kind of check produced the row.
 */
export interface SnapshotDifference {
  readonly scope: string;
  readonly published: number | string | null;
  readonly recomputed: number | string | null;
}

function entityScores(entities: readonly EntityScore[]): Map<string, EntityScore> {
  return new Map(entities.map((entry) => [entry.entityId, entry]));
}

function scoreOf(entry: EntityScore | undefined): number | null {
  return entry?.status === 'scored' ? entry.score : null;
}

/** Definition identity, headline score and the coverage that qualifies it. */
function compareAggregates(
  published: IndexSnapshot,
  recomputed: IndexSnapshot,
): SnapshotDifference[] {
  const differences: SnapshotDifference[] = [];
  const digest = definitionDigest(published.definition);
  if (digest !== published.definitionSha256) {
    differences.push({
      scope: 'definition-digest',
      published: published.definitionSha256,
      recomputed: digest,
    });
  }
  if (published.index.score !== recomputed.index.score) {
    differences.push({
      scope: 'headline',
      published: published.index.score,
      recomputed: recomputed.index.score,
    });
  }
  for (const [scope, publishedValue, recomputedValue] of [
    ['coverage:seriesScored', published.coverage.seriesScored, recomputed.coverage.seriesScored],
    ['coverage:coverageRatio', published.coverage.coverageRatio, recomputed.coverage.coverageRatio],
    ['coverage:weightScored', published.coverage.weightScored, recomputed.coverage.weightScored],
  ] as const) {
    if (publishedValue !== recomputedValue) {
      differences.push({ scope, published: publishedValue, recomputed: recomputedValue });
    }
  }
  return differences;
}

/** Every signal index and entity score, matched by id rather than position. */
function compareSeries(
  published: IndexSnapshot,
  recomputed: IndexSnapshot,
): SnapshotDifference[] {
  const differences: SnapshotDifference[] = [];
  const recomputedSeries = new Map(recomputed.series.map((entry) => [entry.id, entry]));
  for (const series of published.series) {
    const scope = `series:${series.id}`;
    const rebuild = recomputedSeries.get(series.id);
    if (rebuild === undefined) {
      differences.push({ scope, published: series.index.score, recomputed: null });
      continue;
    }
    if (series.index.score !== rebuild.index.score) {
      differences.push({ scope, published: series.index.score, recomputed: rebuild.index.score });
    }
    const rebuiltEntities = entityScores(rebuild.entities);
    for (const entity of series.entities) {
      const publishedScore = scoreOf(entity);
      const recomputedScore = scoreOf(rebuiltEntities.get(entity.entityId));
      if (publishedScore !== recomputedScore) {
        differences.push({
          scope: `entity:${series.id}/${entity.entityId}`,
          published: publishedScore,
          recomputed: recomputedScore,
        });
      }
    }
  }
  return differences;
}

/**
 * Checks a published epoch against one recomputed from the same definition.
 *
 * The comparison covers the numbers a market settles on and the coverage that
 * qualifies them; timestamps and generated-at fields are deliberately excluded,
 * because a recompute necessarily happens later and would always differ.
 */
export function compareSnapshots(
  published: IndexSnapshot,
  recomputed: IndexSnapshot,
): readonly SnapshotDifference[] {
  return [...compareAggregates(published, recomputed), ...compareSeries(published, recomputed)];
}
