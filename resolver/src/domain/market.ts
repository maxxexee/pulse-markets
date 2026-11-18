import { canonicalJson, sha256Hex } from '../../../index-service/src/domain/snapshot.ts';
import { decodeBase58 } from '../../../index-service/src/domain/base58.ts';
import { isValidDay } from '../../../index-service/src/domain/dates.ts';

/** Which side of the threshold resolves the market YES. */
export type ThresholdComparison = 'above' | 'below';

/**
 * Confidence a snapshot must reach before it may settle a market.
 *
 * A score computed from a fragment of the basket is still a published number,
 * but it is not a settlement-grade one. Half the expected series is the floor:
 * below it the reading is missing an entire signal or most of an entity set.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * The fixed terms of one attention market.
 *
 * Every field is part of the market identity, so two parties who agree on terms
 * derive the same id without coordinating. Changing a term creates a different
 * market rather than editing this one.
 */
export interface MarketDefinition {
  /** Published index definition the market settles under. */
  readonly definitionId: string;
  /**
   * Hex SHA-256 of that definition, when the market pins the exact terms.
   *
   * The id alone names the terms; this fixes them. Without it, a resolver trusts
   * the publisher to keep meaning the same anchors and weights by the same name.
   * Optional so markets written before the definition was embedded stay valid.
   */
  readonly definitionSha256?: string;
  /** Base58 Ed25519 key whose snapshots are accepted as settlement evidence. */
  readonly signer: string;
  /** Index points, 0 to 100, up to two decimals. */
  readonly threshold: number;
  readonly comparison: ThresholdComparison;
  /** UTC epoch day whose published index resolves the market. */
  readonly epochDay: string;
  /** Minimum snapshot coverage ratio accepted, 0 to 1. */
  readonly minConfidence: number;
  /** ISO timestamp the terms were fixed. */
  readonly createdAt: string;
}

export interface MarketSpec extends MarketDefinition {
  /** Hex SHA-256 of the canonical definition. */
  readonly id: string;
}

export type MarketErrorKind =
  | 'invalid-threshold'
  | 'invalid-definition-hash'
  | 'invalid-comparison'
  | 'invalid-day'
  | 'invalid-signer'
  | 'invalid-coverage'
  | 'invalid-definition';

export class MarketError extends Error {
  readonly kind: MarketErrorKind;

  constructor(kind: MarketErrorKind, message: string) {
    super(message);
    this.name = 'MarketError';
    this.kind = kind;
  }
}

/** Index points carry two decimals, so a market cannot price a finer claim. */
function validThreshold(value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  if (value < 0 || value > 100) {
    return false;
  }
  // 58.11 * 100 is 5811.000000000001 in binary floating point, so compare
  // against the rounded value with a tolerance rather than for exact equality.
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/** True when the key decodes to a 32 byte Ed25519 public key. */
function validSigner(signer: string): boolean {
  try {
    return decodeBase58(signer).length === 32;
  } catch {
    return false;
  }
}

/**
 * Validates terms and derives the market id.
 *
 * The id is the hash of the canonical definition, using the same canonical form
 * as the signed snapshot. That is deliberate: a market and the evidence that
 * settles it are then identified by one shared encoding.
 */
export function createMarketSpec(definition: MarketDefinition): MarketSpec {
  if (!validThreshold(definition.threshold)) {
    throw new MarketError(
      'invalid-threshold',
      `threshold must be 0 to 100 with at most two decimals, got ${definition.threshold}`,
    );
  }
  if (definition.comparison !== 'above' && definition.comparison !== 'below') {
    throw new MarketError('invalid-comparison', `unknown comparison: ${definition.comparison}`);
  }
  if (!isValidDay(definition.epochDay)) {
    throw new MarketError('invalid-day', `invalid epoch day: ${definition.epochDay}`);
  }
  if (!validSigner(definition.signer)) {
    throw new MarketError('invalid-signer', `signer is not a 32 byte base58 key: ${definition.signer}`);
  }
  const pinned = definition.definitionSha256;
  if (pinned !== undefined && !/^[0-9a-f]{64}$/.test(pinned)) {
    throw new MarketError(
      'invalid-definition-hash',
      `definitionSha256 must be 64 hex characters, got ${pinned}`,
    );
  }
  if (!(definition.minConfidence >= 0 && definition.minConfidence <= 1)) {
    throw new MarketError(
      'invalid-coverage',
      `minConfidence must be 0 to 1, got ${definition.minConfidence}`,
    );
  }
  return { ...definition, id: sha256Hex(canonicalJson(definition)) };
}
