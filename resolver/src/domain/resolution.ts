import type { SignedSnapshot } from '@pulse/index-core/attestation.ts';
import { verifySignedSnapshot } from '@pulse/index-core/attestation.ts';
import { coverageRatioOf } from '@pulse/index-core/coverage.ts';
import type { MarketSpec, ThresholdComparison } from './market.ts';

export type ResolutionOutcome = 'yes' | 'no';

export type ResolutionErrorKind =
  | 'unverified-snapshot'
  | 'untrusted-signer'
  | 'wrong-definition'
  | 'wrong-epoch'
  | 'missing-index'
  | 'insufficient-coverage';

export interface Resolution {
  readonly status: 'resolved';
  readonly marketId: string;
  readonly definitionId: string;
  readonly epochDay: string;
  readonly indexScore: number;
  readonly threshold: number;
  readonly comparison: ThresholdComparison;
  readonly outcome: ResolutionOutcome;
  /** Tie policy is part of the published rule, not an implementation detail. */
  readonly policy: 'tie-resolves-no';
  /** Snapshot payload the outcome was read from, so the evidence is pinned. */
  readonly snapshotPayloadSha256: string;
  readonly snapshotSigner: string;
  readonly resolvedAt: string;
}

export type ResolveError = {
  readonly kind: ResolutionErrorKind;
  readonly message: string;
};

export type ResolveResult =
  | { readonly ok: true; readonly resolution: Resolution }
  | { readonly ok: false; readonly error: ResolveError };

/**
 * Applies the threshold rule.
 *
 * A score exactly equal to the threshold resolves NO for both directions. That
 * is stated in the resolution record because a settled market must never depend
 * on an unstated tie convention.
 */
export function decide(
  comparison: ThresholdComparison,
  indexScore: number,
  threshold: number,
): ResolutionOutcome {
  if (comparison === 'above') {
    return indexScore > threshold ? 'yes' : 'no';
  }
  return indexScore < threshold ? 'yes' : 'no';
}

/**
 * Verification for hostile input: a malformed key or signature encoding throws
 * inside the crypto layer, and that must read as "not verified", not a crash.
 */
function verified(signed: SignedSnapshot): boolean {
  try {
    return verifySignedSnapshot(signed);
  } catch {
    return false;
  }
}

/** A settled score, or the reason the snapshot may not settle this market. */
type Evidence =
  | { readonly score: number; readonly error: null }
  | { readonly score: null; readonly error: ResolveError };

function readEvidence(spec: MarketSpec, signed: SignedSnapshot): Evidence {
  if (!verified(signed)) {
    return evidenceError(
      'unverified-snapshot',
      'snapshot payload hash or signature does not verify',
    );
  }
  if (signed.attestation.publicKey !== spec.signer) {
    return evidenceError(
      'untrusted-signer',
      `snapshot signed by ${signed.attestation.publicKey}, market accepts ${spec.signer}`,
    );
  }
  if (signed.snapshot.definitionId !== spec.definitionId) {
    return evidenceError(
      'wrong-definition',
      `snapshot is ${signed.snapshot.definitionId}, market settles on ${spec.definitionId}`,
    );
  }
  const pinnedHash = spec.definitionSha256;
  if (pinnedHash !== undefined && signed.snapshot.definitionSha256 !== pinnedHash) {
    return evidenceError(
      'wrong-definition',
      `snapshot definition hash is ${signed.snapshot.definitionSha256}, market pins ${pinnedHash}`,
    );
  }
  if (signed.snapshot.epochDay !== spec.epochDay) {
    return evidenceError(
      'wrong-epoch',
      `snapshot is for ${signed.snapshot.epochDay}, market settles on ${spec.epochDay}`,
    );
  }
  const score = signed.snapshot.index.score;
  if (score === null) {
    return evidenceError('missing-index', 'snapshot has no headline index score');
  }
  const coverageRatio = coverageRatioOf(signed.snapshot.coverage);
  if (coverageRatio === null || coverageRatio < spec.minConfidence) {
    return evidenceError(
      'insufficient-coverage',
      `snapshot coverage ${coverageRatio} is below the market floor ${spec.minConfidence}`,
    );
  }
  return { score, error: null };
}

function evidenceError(kind: ResolutionErrorKind, message: string): Evidence {
  return { score: null, error: { kind, message } };
}

/**
 * Resolves one market against one signed snapshot.
 *
 * Every check that can invalidate the evidence runs before the outcome is
 * computed, and a failure returns a typed error rather than a default, so no
 * market can be settled from a snapshot the terms did not authorise.
 */
export function resolveMarket(spec: MarketSpec, signed: SignedSnapshot, now: Date): ResolveResult {
  const evidence = readEvidence(spec, signed);
  if (evidence.error !== null) {
    return { ok: false, error: evidence.error };
  }
  const score = evidence.score;
  return {
    ok: true,
    resolution: {
      status: 'resolved',
      marketId: spec.id,
      definitionId: spec.definitionId,
      epochDay: spec.epochDay,
      indexScore: score,
      threshold: spec.threshold,
      comparison: spec.comparison,
      outcome: decide(spec.comparison, score, spec.threshold),
      policy: 'tie-resolves-no',
      snapshotPayloadSha256: signed.attestation.payloadSha256,
      snapshotSigner: signed.attestation.publicKey,
      resolvedAt: now.toISOString(),
    },
  };
}
