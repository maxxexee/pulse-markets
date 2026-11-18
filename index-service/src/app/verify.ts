import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifySignedSnapshot, type SignedSnapshot } from '../adapters/attestation.ts';
import { ENTITY_BASKET } from '../config/entities.ts';
import type { IndexSnapshot } from '../domain/snapshot.ts';
import { compareSnapshots, type SnapshotDifference } from '../domain/verify.ts';
import { buildSnapshot } from './build-snapshot.ts';

export type VerificationStatus = 'verified' | 'differs' | 'unreadable';

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly epochDay: string | null;
  /** Empty when verified; every disagreement otherwise. */
  readonly differences: readonly SnapshotDifference[];
  /** One line a human or a log can read without parsing the rest. */
  readonly detail: string;
}

function unreadable(epochDay: string | null, detail: string): VerificationResult {
  return { status: 'unreadable', epochDay, differences: [], detail };
}

async function readPublished(path: string, day: string): Promise<SignedSnapshot | VerificationResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unreadable(day, `cannot read ${path}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable(day, `${path} is not JSON`);
  }
  const signed = parsed as Partial<SignedSnapshot>;
  if (signed.snapshot === undefined || signed.attestation === undefined) {
    return unreadable(day, `${path} has no snapshot and attestation`);
  }
  return signed as SignedSnapshot;
}

/**
 * Recomputes a published epoch from today's source data and compares it.
 *
 * This is the check a third party can run: the snapshot names every URL it read
 * and embeds the terms it scored under, so a rebuild needs no private state. A
 * difference means either the source revised its figures or the code no longer
 * reproduces the published numbers, and both are worth knowing before a market
 * settles on them.
 */
export async function verifyDay(
  snapshotsDir: string,
  day: string,
): Promise<VerificationResult> {
  const published = await readPublished(join(snapshotsDir, `${day}.json`), day);
  if ('status' in published) {
    return published;
  }
  if (!verifySignedSnapshot(published)) {
    return unreadable(day, `snapshot payload hash or signature does not verify`);
  }
  const snapshot: IndexSnapshot = published.snapshot;
  if (snapshot.definition === undefined) {
    return unreadable(
      snapshot.epochDay,
      `${snapshot.epochDay} has no embedded definition, so a rebuild cannot know its terms`,
    );
  }
  let recomputed: IndexSnapshot;
  try {
    recomputed = await buildSnapshot({
      entities: ENTITY_BASKET,
      definition: snapshot.definition,
      targetDay: snapshot.epochDay,
      now: new Date(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unreadable(snapshot.epochDay, `rebuild failed: ${detail}`);
  }
  const differences = compareSnapshots(snapshot, recomputed);
  if (differences.length === 0) {
    return {
      status: 'verified',
      epochDay: snapshot.epochDay,
      differences,
      detail: `epoch ${snapshot.epochDay} recomputes to ${recomputed.index.score}`,
    };
  }
  return {
    status: 'differs',
    epochDay: snapshot.epochDay,
    differences,
    detail: `${differences.length} value(s) differ from the published snapshot`,
  };
}
