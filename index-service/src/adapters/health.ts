import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifySignedSnapshot, type SignedSnapshot } from './attestation.ts';
import { toDay } from '../domain/dates.ts';
import { assessHealth, type HealthReport, type PublishedSnapshotView } from '../domain/health.ts';

/** One day of lag is normal: the build for today has not run yet. Two is a miss. */
export const DEFAULT_MAX_AGE_DAYS = 1;

const SNAPSHOT_FILE = 'latest.json';

function verified(signed: SignedSnapshot): boolean {
  try {
    return verifySignedSnapshot(signed);
  } catch {
    return false;
  }
}

/** Returns the fields health needs, or null when the file is not a usable snapshot. */
function view(signed: unknown): PublishedSnapshotView | null {
  const candidate = signed as Partial<SignedSnapshot> | null;
  const snapshot = candidate?.snapshot;
  const attestation = candidate?.attestation;
  if (
    snapshot === undefined ||
    attestation === undefined ||
    typeof snapshot.epochDay !== 'string' ||
    typeof attestation.publicKey !== 'string' ||
    typeof attestation.payloadSha256 !== 'string'
  ) {
    return null;
  }
  return {
    epochDay: snapshot.epochDay,
    indexScore: typeof snapshot.index?.score === 'number' ? snapshot.index.score : null,
    confidence: typeof snapshot.coverage?.confidence === 'number' ? snapshot.coverage.confidence : null,
    signer: attestation.publicKey,
    payloadSha256: attestation.payloadSha256,
  };
}

/**
 * Reads the published snapshot and answers whether the index is current.
 *
 * Read-only and cheap enough for a monitor to poll: one small file, no network.
 * An unreadable or malformed file is reported as missing, because to a consumer
 * of the index it is indistinguishable from one that was never published.
 */
export async function readSnapshotHealth(args: {
  readonly snapshotsDir: string;
  readonly maxAgeDays?: number;
  readonly now?: Date;
}): Promise<HealthReport> {
  const now = args.now ?? new Date();
  const maxAgeDays = args.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const today = toDay(now);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(args.snapshotsDir, SNAPSHOT_FILE), 'utf8'));
  } catch {
    return assessHealth({ latest: null, signatureValid: false, today, maxAgeDays, now });
  }

  const published = view(parsed);
  if (published === null) {
    return assessHealth({ latest: null, signatureValid: false, today, maxAgeDays, now });
  }
  return assessHealth({
    latest: published,
    signatureValid: verified(parsed as SignedSnapshot),
    today,
    maxAgeDays,
    now,
  });
}
