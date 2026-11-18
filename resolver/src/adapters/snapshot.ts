import { readFile } from 'node:fs/promises';
import type { SignedSnapshot } from '@pulse/index-core/attestation.ts';

export type SnapshotReadErrorKind = 'not-found' | 'malformed';

export class SnapshotReadError extends Error {
  readonly kind: SnapshotReadErrorKind;

  constructor(kind: SnapshotReadErrorKind, message: string) {
    super(message);
    this.name = 'SnapshotReadError';
    this.kind = kind;
  }
}

/**
 * Reads a published snapshot file.
 *
 * This checks shape only. Whether the payload and signature are valid is the
 * settlement rule's decision, so a malformed or forged file reaches it as
 * evidence that fails verification rather than as a read error.
 */
export async function readSignedSnapshot(path: string): Promise<SignedSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SnapshotReadError('not-found', `cannot read ${path}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SnapshotReadError('malformed', `${path} is not JSON`);
  }
  const signed = parsed as Partial<SignedSnapshot>;
  if (signed.snapshot === undefined || signed.attestation === undefined) {
    throw new SnapshotReadError('malformed', `${path} has no snapshot and attestation`);
  }
  return signed as SignedSnapshot;
}
