import { signPayload, verifyAttestation, type Attestation, type Signer } from './attestation.ts';
import { canonicalJson, sha256Hex } from './snapshot.ts';
import type { DiscoverySettings } from './discovery.ts';

/**
 * A signed record of one day's discovered topics.
 *
 * Discovery is otherwise display data. This document is what makes a trending
 * topic settleable: the measured numbers, the thresholds they were measured
 * under, and the source URLs are fixed and signed together.
 */
export const TREND_EPOCH_SCHEMA = 'pulse-trends/1';

/** Definition id for the discovery rules a trend market settles under. */
export const TREND_DEFINITION_ID = 'discovery-v1';

export interface TrendSource {
  /** Public URL the measurement was read from. */
  readonly url: string;
  readonly retrievedAt: string;
  readonly payloadSha256: string;
}

export interface TrendEntry {
  readonly article: string;
  readonly topic: string;
  /** Views on the epoch day. */
  readonly views: number;
  /** Mean daily views over the baseline window. */
  readonly baseline: number;
  readonly baselineDays: number;
  /** Percent change from baseline, one decimal. */
  readonly momentum: number;
  /** Present when the topic came in through the X trend list. */
  readonly via?: 'x';
  readonly sources: readonly TrendSource[];
}

export interface TrendEpoch {
  readonly schema: typeof TREND_EPOCH_SCHEMA;
  readonly epochDay: string;
  readonly generatedAt: string;
  readonly method: 'wikipedia-top-v1';
  readonly definitionId: typeof TREND_DEFINITION_ID;
  /** Hex digest of the method and settings, so the terms are pinned. */
  readonly definitionSha256: string;
  readonly settings: DiscoverySettings;
  readonly entries: readonly TrendEntry[];
}

export interface SignedTrendEpoch {
  readonly trends: TrendEpoch;
  readonly attestation: Attestation;
}

/**
 * Terms digest for a trend epoch.
 *
 * The method and settings are the rule that decides which topics appear at all,
 * so a market that pins this digest cannot be settled under looser thresholds.
 */
export function trendDefinitionDigest(
  method: TrendEpoch['method'],
  settings: DiscoverySettings,
): string {
  return sha256Hex(canonicalJson({ schema: TREND_EPOCH_SCHEMA, method, settings }));
}

export function trendSigningPayload(epoch: TrendEpoch): Buffer {
  return Buffer.from(canonicalJson(epoch), 'utf8');
}

export function signTrendEpoch(epoch: TrendEpoch, signer: Signer): SignedTrendEpoch {
  return { trends: epoch, attestation: signPayload(trendSigningPayload(epoch), signer) };
}

/**
 * Checks the signature and that the embedded terms match the digest.
 *
 * Both are required: a valid signature over a document whose digest does not
 * match its own settings would let the publisher change thresholds after the
 * fact while keeping the same market identity.
 */
export function verifySignedTrendEpoch(signed: SignedTrendEpoch): boolean {
  const epoch = signed.trends;
  if (epoch.schema !== TREND_EPOCH_SCHEMA) {
    return false;
  }
  if (epoch.definitionId !== TREND_DEFINITION_ID) {
    return false;
  }
  if (trendDefinitionDigest(epoch.method, epoch.settings) !== epoch.definitionSha256) {
    return false;
  }
  return verifyAttestation(trendSigningPayload(epoch), signed.attestation);
}
