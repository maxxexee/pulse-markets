import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { signerFromKey } from '../src/attestation.ts';
import { DISCOVERY_V1 } from '../src/discovery.ts';
import {
  signTrendEpoch,
  TREND_DEFINITION_ID,
  TREND_EPOCH_SCHEMA,
  trendDefinitionDigest,
  verifySignedTrendEpoch,
  type TrendEpoch,
} from '../src/trend-epoch.ts';

function epoch(): TrendEpoch {
  return {
    schema: TREND_EPOCH_SCHEMA,
    epochDay: '2026-11-18',
    generatedAt: '2026-11-19T00:00:00.000Z',
    method: 'wikipedia-top-v1',
    definitionId: TREND_DEFINITION_ID,
    definitionSha256: trendDefinitionDigest('wikipedia-top-v1', DISCOVERY_V1),
    settings: DISCOVERY_V1,
    entries: [
      {
        article: 'Grand_Theft_Auto_VI',
        topic: 'Grand Theft Auto VI',
        views: 519_632,
        baseline: 89_452,
        baselineDays: 7,
        momentum: 480.7,
        via: 'x',
        sources: [
          {
            url: 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Grand_Theft_Auto_VI/daily/20261111/20261118',
            retrievedAt: '2026-11-19T00:00:00.000Z',
            payloadSha256: 'a'.repeat(64),
          },
        ],
      },
    ],
  };
}

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signerFromKey(privateKey);
}

test('a signed trend epoch verifies', () => {
  const signed = signTrendEpoch(epoch(), signer());
  assert.equal(verifySignedTrendEpoch(signed), true);
});

test('changing a published number breaks verification', () => {
  const signed = signTrendEpoch(epoch(), signer());
  const tampered = {
    ...signed,
    trends: {
      ...signed.trends,
      entries: [{ ...signed.trends.entries[0]!, momentum: 900 }],
    },
  };
  assert.equal(verifySignedTrendEpoch(tampered), false);
});

test('changing thresholds breaks verification through the digest check', () => {
  const signed = signTrendEpoch(epoch(), signer());
  const tampered = {
    ...signed,
    trends: {
      ...signed.trends,
      settings: { ...signed.trends.settings, minViews: 1000 },
    },
  };
  assert.equal(verifySignedTrendEpoch(tampered), false);
});

test('a signature from another key verifies cryptographically but is not the same signer', () => {
  const signed = signTrendEpoch(epoch(), signer());
  assert.equal(verifySignedTrendEpoch(signed), true);
  assert.notEqual(signed.attestation.publicKey, signer().publicKey);
});
