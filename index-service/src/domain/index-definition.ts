import { canonicalJson, sha256Hex } from './snapshot.ts';
import type { ScoringConfig } from './scoring.ts';

/** Identifies the published definition layout, so old definitions stay readable. */
export const DEFINITION_SCHEMA = 'pulse.index.definition/2';

/**
 * One constituent as published: the volume its score is measured against, and
 * its share of the signal index.
 *
 * The anchor is frozen for the life of the definition. A rolling baseline made
 * the level drift with each entity's own slow trend, so a score of 60 in
 * January and a score of 60 in December meant different things and a market
 * written against a level could not say what it was settling on.
 */
export interface ConstituentAnchor {
  readonly entityId: string;
  /** Base-period volume in the signal's unit, or null when unmeasurable. */
  readonly anchor: number;
  /** Published share of the signal index, capped and normalised to sum to 1. */
  readonly weight: number;
  /**
   * Article title per wiki language for signals that read several editions.
   *
   * Frozen here so the pages behind a number are part of the terms. A build
   * that resolved titles at run time would silently follow a page rename and
   * publish a different number under the same definition id.
   */
  readonly titles?: Readonly<Record<string, string>>;
}

/** One signal as published: its formula, its weight, and its constituents. */
export interface PublishedSignal {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  /** Weight of this signal inside the headline index; published weights sum to 1. */
  readonly weight: number;
  /**
   * Formula and anchor method, embedded whole.
   *
   * The baseline window and method fields describe how each anchor below was
   * derived, so a reader can recompute the anchors from the source data.
   */
  readonly scoring: ScoringConfig;
  readonly constituents: readonly ConstituentAnchor[];
}

/**
 * The complete definition a snapshot was computed under.
 *
 * A snapshot embeds this object and its digest, because a market that names
 * only a definition id cannot verify what that id meant at the time. Changing
 * any field here defines a new index and needs a new id.
 */
export interface IndexDefinition {
  readonly schema: typeof DEFINITION_SCHEMA;
  readonly id: string;
  /** Last UTC day of the calibration window, YYYY-MM-DD. */
  readonly baseDay: string;
  readonly calibrationDays: number;
  /** Cap on any single constituent weight inside a signal, 0 to 1. */
  readonly constituentWeightCap: number;
  readonly signals: readonly PublishedSignal[];
}

/** SHA-256 of the canonical definition, the identity a market can pin. */
export function definitionDigest(definition: IndexDefinition): string {
  return sha256Hex(canonicalJson(definition));
}
