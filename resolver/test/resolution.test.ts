import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  signSnapshot,
  signerFromKey,
  type SignedSnapshot,
  type Signer,
} from '../../index-service/src/adapters/attestation.ts';
import {
  DEFINITION_SCHEMA,
  definitionDigest,
  type IndexDefinition,
} from '../../index-service/src/domain/index-definition.ts';
import { SNAPSHOT_SCHEMA, type IndexSnapshot } from '../../index-service/src/domain/snapshot.ts';
import { createMarketSpec, type MarketSpec } from '../src/domain/market.ts';
import { decide, resolveMarket } from '../src/domain/resolution.ts';

const DAY = '2026-11-20';
const DEFINITION = 'pulse-attention-v4';
const NOW = new Date('2026-11-20T12:00:00.000Z');
const DEFINITION_BODY: IndexDefinition = {
  schema: DEFINITION_SCHEMA,
  id: DEFINITION,
  baseDay: '2026-11-16',
  calibrationDays: 180,
  constituentWeightCap: 0.25,
  signals: [],
};
const DEFINITION_HASH = definitionDigest(DEFINITION_BODY);

function newSigner(): Signer {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signerFromKey(privateKey);
}

interface SnapshotOptions {
  readonly score?: number | null;
  readonly coverageRatio?: number;
  readonly definitionId?: string;
  readonly epochDay?: string;
  readonly definitionSha256?: string;
}

function snapshotFor(options: SnapshotOptions = {}): IndexSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: options.epochDay ?? DAY,
    generatedAt: '2026-11-20T00:10:00.000Z',
    definitionId: options.definitionId ?? DEFINITION,
    definition: DEFINITION_BODY,
    definitionSha256: options.definitionSha256 ?? DEFINITION_HASH,
    index: {
      score: options.score === undefined ? 61.5 : options.score,
      scoredEntities: 12,
      totalEntities: 14,
    },
    momentum: null,
    coverage: {
      signalsScored: 2,
      signalsTotal: 2,
      seriesScored: 12,
      seriesExpected: 14,
      coverageRatio: options.coverageRatio ?? 0.8571,
      weightScored: options.coverageRatio ?? 0.8571,
      oldestSourceAt: '2026-11-20T00:02:00.000Z',
    },
    series: [],
    sources: [],
  };
}

function specFor(signer: Signer, overrides: Partial<Parameters<typeof createMarketSpec>[0]> = {}): MarketSpec {
  return createMarketSpec({
    definitionId: DEFINITION,
    signer: signer.publicKey,
    threshold: 55,
    comparison: 'above',
    epochDay: DAY,
    minConfidence: 0.5,
    createdAt: '2026-11-16T09:00:00.000Z',
    ...overrides,
  });
}

function settlement(result: ReturnType<typeof resolveMarket>) {
  assert.equal(result.ok, true, result.ok ? '' : `${result.error.kind}: ${result.error.message}`);
  if (!result.ok) {
    throw new Error('unreachable');
  }
  return result.resolution;
}

function failure(result: ReturnType<typeof resolveMarket>) {
  assert.equal(result.ok, false, 'expected a rejected settlement');
  if (result.ok) {
    throw new Error('unreachable');
  }
  return result.error.kind;
}

test('a pinned definition hash settles only the snapshot computed under it', () => {
  const signer = newSigner();
  const spec = specFor(signer, { definitionSha256: DEFINITION_HASH });
  const settlementOk = settlement(
    resolveMarket(spec, signSnapshot(snapshotFor(), signer), NOW),
  );
  assert.equal(settlementOk.outcome, 'yes');

  const other = specFor(signer, { definitionSha256: 'a'.repeat(64) });
  assert.equal(
    failure(resolveMarket(other, signSnapshot(snapshotFor(), signer), NOW)),
    'wrong-definition',
  );
});

test('a market with no pinned hash settles on the definition id alone', () => {
  const signer = newSigner();
  const spec = specFor(signer);
  assert.equal(spec.definitionSha256, undefined);
  settlement(resolveMarket(spec, signSnapshot(snapshotFor(), signer), NOW));
});

test('above resolves yes above the threshold and no at or below it', () => {
  const signer = newSigner();
  const spec = specFor(signer);
  const yes = settlement(resolveMarket(spec, signSnapshot(snapshotFor(), signer), NOW));
  assert.equal(yes.outcome, 'yes');
  assert.equal(yes.indexScore, 61.5);
  assert.equal(yes.policy, 'tie-resolves-no');
  assert.equal(yes.marketId, spec.id);
  assert.equal(yes.snapshotSigner, signer.publicKey);
  assert.equal(yes.resolvedAt, NOW.toISOString());

  for (const score of [55, 40]) {
    const no = settlement(resolveMarket(spec, signSnapshot(snapshotFor({ score }), signer), NOW));
    assert.equal(no.outcome, 'no', `score ${score}`);
  }
});

test('below resolves yes below the threshold and no at or above it', () => {
  const signer = newSigner();
  const spec = specFor(signer, { comparison: 'below', threshold: 45 });
  const yes = settlement(resolveMarket(spec, signSnapshot(snapshotFor({ score: 40 }), signer), NOW));
  assert.equal(yes.outcome, 'yes');
  for (const score of [45, 70]) {
    const no = settlement(resolveMarket(spec, signSnapshot(snapshotFor({ score }), signer), NOW));
    assert.equal(no.outcome, 'no', `score ${score}`);
  }
});

test('an exact tie resolves no in both directions', () => {
  assert.equal(decide('above', 55, 55), 'no');
  assert.equal(decide('below', 55, 55), 'no');
});

test('rejects a payload edited after signing', () => {
  const signer = newSigner();
  const signed = signSnapshot(snapshotFor(), signer);
  const tampered: SignedSnapshot = {
    ...signed,
    snapshot: { ...signed.snapshot, index: { ...signed.snapshot.index, score: 99 } },
  };
  assert.equal(failure(resolveMarket(specFor(signer), tampered, NOW)), 'unverified-snapshot');
});

test('rejects a snapshot signed by a key the market did not name', () => {
  const signer = newSigner();
  const attacker = newSigner();
  const signed = signSnapshot(snapshotFor(), attacker);
  assert.equal(failure(resolveMarket(specFor(signer), signed, NOW)), 'untrusted-signer');
});

test('rejects a snapshot for another definition or another epoch', () => {
  const signer = newSigner();
  const spec = specFor(signer);
  const otherDefinition = signShot(signer, { definitionId: 'pulse-attention-v5' });
  assert.equal(failure(resolveMarket(spec, otherDefinition, NOW)), 'wrong-definition');
  const otherDay = signShot(signer, { epochDay: '2026-11-19' });
  assert.equal(failure(resolveMarket(spec, otherDay, NOW)), 'wrong-epoch');
});

function signShot(signer: Signer, options: SnapshotOptions): SignedSnapshot {
  return signSnapshot(snapshotFor(options), signer);
}

test('rejects a snapshot with no headline score', () => {
  const signer = newSigner();
  const signed = signShot(signer, { score: null });
  assert.equal(failure(resolveMarket(specFor(signer), signed, NOW)), 'missing-index');
});

test('rejects a snapshot below the market coverage floor', () => {
  const signer = newSigner();
  const signed = signShot(signer, { coverageRatio: 0.1429 });
  assert.equal(failure(resolveMarket(specFor(signer), signed, NOW)), 'insufficient-coverage');
  const lowered = specFor(signer, { minConfidence: 0.1 });
  assert.equal(settlement(resolveMarket(lowered, signed, NOW)).outcome, 'yes');
});

test('a malformed signature is a rejection, not a crash', () => {
  const signer = newSigner();
  const signed = signShot(signer, {});
  const broken: SignedSnapshot = {
    ...signed,
    attestation: { ...signed.attestation, signature: 'not base64 !' },
  };
  assert.equal(failure(resolveMarket(specFor(signer), broken, NOW)), 'unverified-snapshot');
});
