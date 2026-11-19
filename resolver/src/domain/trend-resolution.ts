import {
  verifySignedTrendEpoch,
  type SignedTrendEpoch,
} from '@pulse/index-core/trend-epoch.ts';
import type { TrendMarketSpec, TrendComparison } from './trend-market.ts';

export type TrendResolutionOutcome = 'yes' | 'no';

/** Why the outcome came out as it did, published with the settlement. */
export type TrendResolutionReason =
  | 'threshold'
  | 'topic-not-published'
  | 'below-view-floor'
  | 'too-few-baseline-days';

export type TrendResolutionErrorKind =
  | 'unverified-epoch'
  | 'untrusted-signer'
  | 'wrong-definition'
  | 'wrong-epoch';

export interface TrendResolution {
  readonly status: 'resolved';
  readonly marketId: string;
  readonly kind: 'trend-momentum';
  readonly definitionId: string;
  readonly epochDay: string;
  readonly article: string;
  readonly topic: string;
  readonly momentum: number | null;
  readonly views: number | null;
  readonly baselineDays: number | null;
  readonly threshold: number;
  readonly comparison: TrendComparison;
  readonly minViews: number;
  readonly outcome: TrendResolutionOutcome;
  readonly reason: TrendResolutionReason;
  /** Stated, because a settled market must not depend on an unstated tie rule. */
  readonly policy: 'tie-resolves-no';
  readonly trendsPayloadSha256: string;
  readonly trendsSigner: string;
  readonly resolvedAt: string;
}

export type TrendResolveResult =
  | { readonly ok: true; readonly resolution: TrendResolution }
  | {
      readonly ok: false;
      readonly error: { readonly kind: TrendResolutionErrorKind; readonly message: string };
    };

function decide(
  comparison: TrendComparison,
  momentum: number,
  threshold: number,
): TrendResolutionOutcome {
  if (comparison === 'above') {
    return momentum > threshold ? 'yes' : 'no';
  }
  return momentum < threshold ? 'yes' : 'no';
}

/**
 * Resolves one trend market against one signed epoch.
 *
 * A topic the epoch did not publish resolves NO. The chain has no void path, so
 * absence has to mean something, and the terms say so: a market on a topic that
 * did not trend enough to be listed is a market that did not happen.
 */
/** Every check that can invalidate the evidence, before any outcome is computed. */
function evidenceError(
  spec: TrendMarketSpec,
  signed: SignedTrendEpoch,
): { kind: TrendResolutionErrorKind; message: string } | null {
  let verified = false;
  try {
    verified = verifySignedTrendEpoch(signed);
  } catch {
    verified = false;
  }
  if (!verified) {
    return { kind: 'unverified-epoch', message: 'signature or terms digest does not verify' };
  }
  if (signed.attestation.publicKey !== spec.signer) {
    return {
      kind: 'untrusted-signer',
      message: `epoch signed by ${signed.attestation.publicKey}, market accepts ${spec.signer}`,
    };
  }
  if (signed.trends.definitionId !== spec.definitionId) {
    return {
      kind: 'wrong-definition',
      message: `epoch is ${signed.trends.definitionId}, market settles on ${spec.definitionId}`,
    };
  }
  if (signed.trends.definitionSha256 !== spec.definitionSha256) {
    return {
      kind: 'wrong-definition',
      message: `epoch terms are ${signed.trends.definitionSha256}, market pins ${spec.definitionSha256}`,
    };
  }
  if (signed.trends.epochDay !== spec.epochDay) {
    return {
      kind: 'wrong-epoch',
      message: `epoch is for ${signed.trends.epochDay}, market settles on ${spec.epochDay}`,
    };
  }
  return null;
}

export function resolveTrendMarket(
  spec: TrendMarketSpec,
  signed: SignedTrendEpoch,
  now: Date,
): TrendResolveResult {
  const error = evidenceError(spec, signed);
  if (error !== null) {
    return { ok: false, error };
  }

  const entry = signed.trends.entries.find((item) => item.article === spec.article);
  const base = {
    status: 'resolved' as const,
    marketId: spec.id,
    kind: 'trend-momentum' as const,
    definitionId: spec.definitionId,
    epochDay: spec.epochDay,
    article: spec.article,
    topic: spec.topic,
    threshold: spec.threshold,
    comparison: spec.comparison,
    minViews: spec.minViews,
    policy: 'tie-resolves-no' as const,
    trendsPayloadSha256: signed.attestation.payloadSha256,
    trendsSigner: signed.attestation.publicKey,
    resolvedAt: now.toISOString(),
  };

  if (entry === undefined) {
    return {
      ok: true,
      resolution: {
        ...base,
        momentum: null,
        views: null,
        baselineDays: null,
        outcome: 'no',
        reason: 'topic-not-published',
      },
    };
  }
  if (entry.views < spec.minViews) {
    return {
      ok: true,
      resolution: {
        ...base,
        momentum: entry.momentum,
        views: entry.views,
        baselineDays: entry.baselineDays,
        outcome: 'no',
        reason: 'below-view-floor',
      },
    };
  }
  if (entry.baselineDays < spec.minBaselineDays) {
    return {
      ok: true,
      resolution: {
        ...base,
        momentum: entry.momentum,
        views: entry.views,
        baselineDays: entry.baselineDays,
        outcome: 'no',
        reason: 'too-few-baseline-days',
      },
    };
  }
  return {
    ok: true,
    resolution: {
      ...base,
      momentum: entry.momentum,
      views: entry.views,
      baselineDays: entry.baselineDays,
      outcome: decide(spec.comparison, entry.momentum, spec.threshold),
      reason: 'threshold',
    },
  };
}
