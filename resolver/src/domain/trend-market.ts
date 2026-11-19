import { decodeBase58 } from '@pulse/index-core/base58.ts';
import { isValidDay } from '@pulse/index-core/dates.ts';
import { canonicalJson, sha256Hex } from '@pulse/index-core/snapshot.ts';
import { TREND_DEFINITION_ID } from '@pulse/index-core/trend-epoch.ts';

/** Which side of the momentum threshold resolves the market YES. */
export type TrendComparison = 'above' | 'below';

/**
 * Terms for a market on one discovered topic's pageview momentum.
 *
 * The identity includes the topic article, the pinned discovery terms and the
 * view floor, so two parties derive the same id only when they agree on exactly
 * which measurement settles it.
 */
export interface TrendMarketDefinition {
  readonly kind: 'trend-momentum';
  readonly definitionId: typeof TREND_DEFINITION_ID;
  /** Hex digest of the discovery method and thresholds. */
  readonly definitionSha256: string;
  /** Base58 Ed25519 key whose trend epochs are accepted. */
  readonly signer: string;
  /** Wikipedia article title with underscores, as the epoch records it. */
  readonly article: string;
  /** Display label frozen into the terms. */
  readonly topic: string;
  /** Momentum percent, up to two decimals. */
  readonly threshold: number;
  readonly comparison: TrendComparison;
  /** UTC day whose signed trend epoch settles the market. */
  readonly epochDay: string;
  /** Below this many views the topic resolves NO regardless of momentum. */
  readonly minViews: number;
  /** Below this many baseline days the comparison does not settle. */
  readonly minBaselineDays: number;
  readonly createdAt: string;
}

export interface TrendMarketSpec extends TrendMarketDefinition {
  readonly id: string;
}

export type TrendMarketErrorKind =
  | 'invalid-threshold'
  | 'invalid-comparison'
  | 'invalid-day'
  | 'invalid-signer'
  | 'invalid-definition-hash'
  | 'invalid-topic'
  | 'invalid-views'
  | 'invalid-baseline'
  | 'invalid-definition';

export class TrendMarketError extends Error {
  readonly kind: TrendMarketErrorKind;

  constructor(kind: TrendMarketErrorKind, message: string) {
    super(message);
    this.name = 'TrendMarketError';
    this.kind = kind;
  }
}

function validThreshold(value: number): boolean {
  if (!Number.isFinite(value) || value < -100 || value > 100_000) {
    return false;
  }
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

function validSigner(signer: string): boolean {
  try {
    return decodeBase58(signer).length === 32;
  } catch {
    return false;
  }
}

export function createTrendMarketSpec(definition: TrendMarketDefinition): TrendMarketSpec {
  if (definition.definitionId !== TREND_DEFINITION_ID) {
    throw new TrendMarketError(
      'invalid-definition',
      `unknown discovery definition: ${definition.definitionId}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(definition.definitionSha256)) {
    throw new TrendMarketError(
      'invalid-definition-hash',
      `definitionSha256 must be 64 hex characters, got ${definition.definitionSha256}`,
    );
  }
  if (!validSigner(definition.signer)) {
    throw new TrendMarketError(
      'invalid-signer',
      `signer is not a 32 byte base58 key: ${definition.signer}`,
    );
  }
  if (definition.article.trim() === '' || definition.article.includes(' ')) {
    throw new TrendMarketError(
      'invalid-topic',
      `article must be an underscored title, got ${definition.article}`,
    );
  }
  if (definition.topic.trim() === '') {
    throw new TrendMarketError('invalid-topic', 'topic must not be empty');
  }
  if (!validThreshold(definition.threshold)) {
    throw new TrendMarketError(
      'invalid-threshold',
      `threshold must be -100 to 100000 with at most two decimals, got ${definition.threshold}`,
    );
  }
  if (definition.comparison !== 'above' && definition.comparison !== 'below') {
    throw new TrendMarketError(
      'invalid-comparison',
      `unknown comparison: ${definition.comparison}`,
    );
  }
  if (!isValidDay(definition.epochDay)) {
    throw new TrendMarketError('invalid-day', `invalid epoch day: ${definition.epochDay}`);
  }
  if (!Number.isInteger(definition.minViews) || definition.minViews < 0) {
    throw new TrendMarketError(
      'invalid-views',
      `minViews must be a non-negative integer, got ${definition.minViews}`,
    );
  }
  if (
    !Number.isInteger(definition.minBaselineDays) ||
    definition.minBaselineDays < 0 ||
    definition.minBaselineDays > 30
  ) {
    throw new TrendMarketError(
      'invalid-baseline',
      `minBaselineDays must be 0 to 30, got ${definition.minBaselineDays}`,
    );
  }
  return { ...definition, id: sha256Hex(canonicalJson(definition)) };
}
