import { readFile } from 'node:fs/promises';
import type { SignedTrendEpoch } from '@pulse/index-core/trend-epoch.ts';

export type TrendEpochReadErrorKind = 'not-found' | 'malformed';

export class TrendEpochReadError extends Error {
  readonly kind: TrendEpochReadErrorKind;

  constructor(kind: TrendEpochReadErrorKind, message: string) {
    super(message);
    this.name = 'TrendEpochReadError';
    this.kind = kind;
  }
}

/**
 * Reads a signed trend epoch file.
 *
 * Shape only. Whether the signature and terms are valid belongs to the
 * settlement rule, so a forged file arrives there as failed evidence rather
 * than as a read error.
 */
export async function readSignedTrendEpochFile(path: string): Promise<SignedTrendEpoch> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TrendEpochReadError('not-found', `cannot read ${path}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrendEpochReadError('malformed', `${path} is not JSON`);
  }
  const signed = parsed as Partial<SignedTrendEpoch>;
  if (signed.trends === undefined || signed.attestation === undefined) {
    throw new TrendEpochReadError('malformed', `${path} has no trends and attestation`);
  }
  return signed as SignedTrendEpoch;
}
