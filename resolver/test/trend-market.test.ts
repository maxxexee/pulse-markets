import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { signerFromKey } from '@pulse/index-core/attestation.ts';
import { DISCOVERY_V1 } from '@pulse/index-core/discovery.ts';
import {
  signTrendEpoch,
  TREND_DEFINITION_ID,
  TREND_EPOCH_SCHEMA,
  trendDefinitionDigest,
  type SignedTrendEpoch,
  type TrendEpoch,
} from '@pulse/index-core/trend-epoch.ts';
import { createTrendMarketSpec, type TrendMarketDefinition } from '../src/domain/trend-market.ts';
import { resolveTrendMarket } from '../src/domain/trend-resolution.ts';

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signerFromKey(privateKey);
}

const digest = trendDefinitionDigest('wikipedia-top-v1', DISCOVERY_V1);
const fixedSigner = signer();

function terms(overrides: Partial<TrendMarketDefinition> = {}): TrendMarketDefinition {
  return {
    kind: 'trend-momentum',
    definitionId: TREND_DEFINITION_ID,
    definitionSha256: digest,
    signer: fixedSigner.publicKey,
    article: 'Grand_Theft_Auto_VI',
    topic: 'Grand Theft Auto VI',
    threshold: 300,
    comparison: 'above',
    epochDay: '2026-11-18',
    minViews: 20_000,
    minBaselineDays: 3,
    createdAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

function signedEpoch(overrides: Partial<TrendEpoch> = {}): SignedTrendEpoch {
  const key = signer();
  const epoch: TrendEpoch = {
    schema: TREND_EPOCH_SCHEMA,
    epochDay: '2026-11-18',
    generatedAt: '2026-11-19T00:00:00.000Z',
    method: 'wikipedia-top-v1',
    definitionId: TREND_DEFINITION_ID,
    definitionSha256: digest,
    settings: DISCOVERY_V1,
    entries: [
      {
        article: 'Grand_Theft_Auto_VI',
        topic: 'Grand Theft Auto VI',
        views: 519_632,
        baseline: 89_452,
        baselineDays: 7,
        momentum: 480.7,
        sources: [],
      },
    ],
    ...overrides,
  };
  return signTrendEpoch(epoch, key);
}

test('terms reject a topic written with spaces and a bad threshold', () => {
  assert.throws(() => createTrendMarketSpec(terms({ article: 'Grand Theft Auto VI' })));
  assert.throws(() => createTrendMarketSpec(terms({ threshold: 300.123 })));
});

test('terms id is stable for the same fields', () => {
  const a = createTrendMarketSpec(terms());
  const b = createTrendMarketSpec(terms());
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, createTrendMarketSpec(terms({ threshold: 301 })).id);
});

test('momentum above the threshold resolves YES', () => {
  const epoch = signedEpoch();
  const spec = createTrendMarketSpec(terms({ signer: epoch.attestation.publicKey }));
  const result = resolveTrendMarket(spec, epoch, new Date('2026-11-19T01:00:00Z'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.resolution.outcome, 'yes');
  assert.equal(result.resolution.reason, 'threshold');
  assert.equal(result.resolution.momentum, 480.7);
});

test('a topic the epoch did not publish resolves NO with a reason', () => {
  const epoch = signedEpoch();
  const spec = createTrendMarketSpec(
    terms({ signer: epoch.attestation.publicKey, article: 'Somebody_Else', topic: 'Somebody Else' }),
  );
  const result = resolveTrendMarket(spec, epoch, new Date('2026-11-19T01:00:00Z'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.resolution.outcome, 'no');
  assert.equal(result.resolution.reason, 'topic-not-published');
});

test('the view floor overrides a large percentage', () => {
  const epoch = signedEpoch();
  const spec = createTrendMarketSpec(
    terms({ signer: epoch.attestation.publicKey, minViews: 1_000_000 }),
  );
  const result = resolveTrendMarket(spec, epoch, new Date('2026-11-19T01:00:00Z'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.resolution.outcome, 'no');
  assert.equal(result.resolution.reason, 'below-view-floor');
});

test('a tampered epoch is rejected before any outcome is computed', () => {
  const epoch = signedEpoch();
  const spec = createTrendMarketSpec(terms({ signer: epoch.attestation.publicKey }));
  const tampered = {
    ...epoch,
    trends: {
      ...epoch.trends,
      entries: [{ ...epoch.trends.entries[0]!, momentum: 900 }],
    },
  };
  const result = resolveTrendMarket(spec, tampered, new Date('2026-11-19T01:00:00Z'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'unverified-epoch');
});

test('an epoch from another signer is refused', () => {
  const epoch = signedEpoch();
  const spec = createTrendMarketSpec(terms({ signer: signer().publicKey }));
  const result = resolveTrendMarket(spec, epoch, new Date('2026-11-19T01:00:00Z'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'untrusted-signer');
});
