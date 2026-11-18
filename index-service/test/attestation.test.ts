import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { TEST_DEFINITION, TEST_DEFINITION_SHA256 } from './definition-fixture.ts';
import { signSnapshot, signerFromKey, verifySignedSnapshot } from '../src/adapters/attestation.ts';
import { SNAPSHOT_SCHEMA, type IndexSnapshot } from '@pulse/index-core/snapshot.ts';
import { PULSE_SCORING_V1 } from '@pulse/index-core/scoring.ts';

function fixtureSnapshot(): IndexSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: '2026-11-15',
    generatedAt: '2026-11-16T00:05:00.000Z',
    definitionId: TEST_DEFINITION.id,
    definition: TEST_DEFINITION,
    definitionSha256: TEST_DEFINITION_SHA256,
    index: { score: 75, scoredEntities: 1, totalEntities: 1 },
    momentum: null,
    coverage: {
      signalsScored: 1,
      signalsTotal: 1,
      seriesScored: 1,
      seriesExpected: 1,
      coverageRatio: 1,
      weightScored: 1,
      oldestSourceAt: '2026-11-16T00:05:00.000Z',
    },
    series: [
      {
        id: 'wikipedia-pageviews',
        label: 'Wikipedia pageviews',
        unit: 'views',
        scoring: PULSE_SCORING_V1,
        index: { score: 75, scoredEntities: 1, totalEntities: 1 },
        momentum: null,
        entities: [
          {
            status: 'scored',
            entityId: 'nvidia',
            day: '2026-11-15',
            value: 200,
            baseline: 100,
            baselineDays: 30,
            level: 2,
            score: 75,
          },
        ],
      },
    ],
    sources: [],
  };
}

const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);

describe('snapshot attestation', () => {
  it('publishes a base58 key that decodes to 32 bytes', () => {
    assert.equal(signer.publicKey.length >= 43 && signer.publicKey.length <= 44, true);
  });

  it('verifies a snapshot it signed', () => {
    assert.equal(verifySignedSnapshot(signSnapshot(fixtureSnapshot(), signer)), true);
  });

  it('rejects a snapshot whose score was edited', () => {
    const signed = signSnapshot(fixtureSnapshot(), signer);
    const tampered = {
      ...signed,
      snapshot: { ...signed.snapshot, index: { ...signed.snapshot.index, score: 99 } },
    };
    assert.equal(verifySignedSnapshot(tampered), false);
  });

  it('rejects a forged signature', () => {
    const signed = signSnapshot(fixtureSnapshot(), signer);
    const forged = {
      ...signed,
      attestation: { ...signed.attestation, signature: Buffer.alloc(64).toString('base64') },
    };
    assert.equal(verifySignedSnapshot(forged), false);
  });

  it('rejects a payload hash that does not match', () => {
    const signed = signSnapshot(fixtureSnapshot(), signer);
    const mismatched = {
      ...signed,
      attestation: { ...signed.attestation, payloadSha256: '0'.repeat(64) },
    };
    assert.equal(verifySignedSnapshot(mismatched), false);
  });
});
