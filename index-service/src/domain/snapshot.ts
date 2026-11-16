import { createHash } from 'node:crypto';
import type { EntityScore, IndexAggregate, ScoringConfig } from './scoring.ts';

/** Identifies the snapshot layout, so old snapshots stay readable after upgrades. */
export const SNAPSHOT_SCHEMA = 'pulse.index.snapshot/1';

/**
 * Provenance for one entity's raw inputs.
 *
 * A snapshot is only an oracle if a third party can refetch the same URL and
 * arrive at the same numbers. The URL, retrieval time and payload hash are
 * published so a disagreement can be traced to a specific fetch.
 */
export interface SourceRecord {
  readonly entityId: string;
  readonly url: string;
  readonly retrievedAt: string;
  /** SHA-256 of the exact response bytes, hex encoded. */
  readonly payloadSha256: string;
  readonly observations: number;
  readonly firstDay: string | null;
  readonly lastDay: string | null;
}

/** The complete published record for one epoch. */
export interface IndexSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  /** UTC day the index describes, YYYY-MM-DD. */
  readonly epochDay: string;
  readonly generatedAt: string;
  readonly index: IndexAggregate;
  readonly scoring: ScoringConfig;
  readonly entities: readonly EntityScore[];
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
