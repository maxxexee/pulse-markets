import { createHash } from 'node:crypto';
import type { EntityScore, IndexAggregate, ScoringConfig } from './scoring.ts';

/** Identifies the snapshot layout, so old snapshots stay readable after upgrades. */
export const SNAPSHOT_SCHEMA = 'pulse.index.snapshot/2';

/**
 * Provenance for one entity's raw inputs.
 *
 * A snapshot is only an oracle if a third party can refetch the same URLs and
 * arrive at the same numbers. Every URL fetched for the series is listed, in
 * order, and the payload hash covers those responses in that same order.
 */
export interface SourceRecord {
  readonly entityId: string;
  readonly signal: string;
  /** Every URL fetched, in request order. */
  readonly urls: readonly string[];
  readonly retrievedAt: string;
  /** SHA-256 of the concatenated response bodies, joined with newlines, hex encoded. */
  readonly payloadSha256: string;
  readonly observations: number;
  readonly firstDay: string | null;
  readonly lastDay: string | null;
}

/** One source's view of the basket: its own index and its own per-entity scores. */
export interface SignalSeries {
  readonly id: string;
  readonly label: string;
  /** Unit of the raw counts, used for display. */
  readonly unit: string;
  /** Formula parameters that produced this series. */
  readonly scoring: ScoringConfig;
  readonly index: IndexAggregate;
  readonly entities: readonly EntityScore[];
}

/** The complete published record for one epoch. */
export interface IndexSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  /** UTC day the index describes, YYYY-MM-DD. */
  readonly epochDay: string;
  readonly generatedAt: string;
  /** Headline index: the mean of the signal indices that scored. */
  readonly index: IndexAggregate;
  readonly series: readonly SignalSeries[];
  readonly sources: readonly SourceRecord[];
}

/**
 * Recursively sorts object keys so that hashing is independent of insertion
 * order. Without this, re-serialising the same data from a different code path
 * would produce a different hash and break verification.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        out[key] = canonicalize(entry);
      }
    }
    return out;
  }
  return value;
}

/** Serialises a value with sorted keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 of a UTF-8 string or byte buffer, hex encoded. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
