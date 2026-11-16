import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { signSnapshot, signerFromKey, verifySignedSnapshot } from '../src/adapters/attestation.ts';
import { SNAPSHOT_SCHEMA, type IndexSnapshot } from '../src/domain/snapshot.ts';
import { PULSE_SCORING_V1 } from '../src/domain/scoring.ts';

function fixtureSnapshot(): IndexSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: '2026-11-15',
    generatedAt: '2026-11-16T00:05:00.000Z',
    index: { score: 62.5, scoredEntities: 1, totalEntities: 1 },
    scoring: PULSE_SCORING_V1,
    entities: [
      {
        status: 'scored',
        entityId: 'nvidia',
        day: '2026-11-15',
        views: 200,
        baseline: 100,
        baselineDays: 30,
        level: 2,
        score: 75,
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
