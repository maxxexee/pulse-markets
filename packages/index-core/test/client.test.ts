import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';
import type { EntityScore } from '../src/scoring.ts';
import { encodeBase58 } from '../src/base58.ts';
import { IndexClientError, readHistory, readLatest } from '../src/client.ts';
import { signingPayload, type Attestation } from '../src/attestation.ts';
import {
  SNAPSHOT_SCHEMA,
  sha256Hex,
  type IndexSnapshot,
  type SignalSeries,
} from '../src/snapshot.ts';
import { TEST_DEFINITION, TEST_DEFINITION_SHA256 } from './definition-fixture.ts';

const BASE = 'https://index.example/';

function scored(entityId: string, score: number): Extract<EntityScore, { status: 'scored' }> {
  return {
    status: 'scored',
    entityId,
    day: '2026-11-16',
    value: 1000,
    baseline: 1000,
    baselineDays: 180,
    level: 1,
    score,
  };
}

function fixtureSnapshot(): IndexSnapshot {
  const entities = [scored('nvidia', 60), scored('openai', 40)];
  const series: SignalSeries = {
    id: 'wikipedia-pageviews',
    label: 'Wikipedia pageviews',
    unit: 'views',
    scoring: TEST_DEFINITION.signals[0]?.scoring ?? ({} as SignalSeries['scoring']),
    index: { score: 50, scoredEntities: 2, totalEntities: 2 },
    momentum: null,
    entities,
  };
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay: '2026-11-16',
    generatedAt: '2026-11-17T09:15:00.000Z',
    definitionId: TEST_DEFINITION.id,
    definition: TEST_DEFINITION,
    definitionSha256: TEST_DEFINITION_SHA256,
    index: { score: 50, scoredEntities: 2, totalEntities: 2 },
    momentum: null,
    coverage: {
      signalsScored: 1,
      signalsTotal: 1,
      seriesScored: 2,
      seriesExpected: 2,
      coverageRatio: 1,
      weightScored: 1,
      oldestSourceAt: '2026-11-17T09:10:00.000Z',
    },
    series: [series],
    sources: [],
  };
}

function signedPayload(): { snapshot: IndexSnapshot; attestation: Attestation } {
  const snapshot = fixtureSnapshot();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const payload = signingPayload(snapshot);
  return {
    snapshot,
    attestation: {
      alg: 'ed25519',
      publicKey: encodeBase58(raw),
      signature: sign(null, payload, privateKey as KeyObject).toString('base64'),
      payloadSha256: sha256Hex(payload),
      canonicalization: 'json-sorted-keys-v1',
    },
  };
}

function respond(body: unknown, status = 200): typeof fetch {
  return async (input) => {
    const url = String(input);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-url': url },
    });
  };
}

test('a signed snapshot reads back as verified', async () => {
  const { snapshot, attestation } = signedPayload();
  const reading = await readLatest({ baseUrl: BASE, fetchImpl: respond({ snapshot, attestation }) });
  assert.equal(reading.verified, true);
  assert.equal(reading.snapshot.index.score, 50);
  assert.equal(reading.snapshot.epochDay, '2026-11-16');
});

test('a tampered level is reported as unverified rather than thrown', async () => {
  const { snapshot, attestation } = signedPayload();
  const tampered = { ...snapshot, index: { ...snapshot.index, score: 90 } };
  const reading = await readLatest({
    baseUrl: BASE,
    fetchImpl: respond({ snapshot: tampered, attestation }),
  });
  assert.equal(reading.verified, false);
  assert.equal(reading.snapshot.index.score, 90);
});

test('a latest payload without a level is a shape error', async () => {
  await assert.rejects(
    readLatest({ baseUrl: BASE, fetchImpl: respond({ snapshot: { epochDay: '2026-11-16' }, attestation: {} }) }),
    (error: unknown) => error instanceof IndexClientError && error.kind === 'shape',
  );
});

test('history days come back in published order', async () => {
  const day = (date: string, level: number, digest: string) => ({
    day: date,
    index: level,
    definitionId: 'pulse-attention-v6',
    definitionSha256: digest,
    momentum: 0.4,
    coverageRatio: 1,
    seriesScored: 7,
    seriesExpected: 7,
  });
  const days = [day('2026-11-15', 61.2, 'a'), day('2026-11-16', 66.8, 'b')];
  const history = await readHistory({ baseUrl: BASE, fetchImpl: respond({ days }) });
  assert.deepEqual(history.map((entry) => entry.day), ['2026-11-15', '2026-11-16']);
});

test('an HTTP failure names the status', async () => {
  await assert.rejects(
    readLatest({ baseUrl: BASE, fetchImpl: respond('missing', 404) }),
    (error: unknown) =>
      error instanceof IndexClientError && error.kind === 'http' && error.status === 404,
  );
});

test('a non-JSON body is a shape error, not a crash', async () => {
  await assert.rejects(
    readHistory({ baseUrl: BASE, fetchImpl: respond('<html>nope</html>') }),
    (error: unknown) => error instanceof IndexClientError && error.kind === 'shape',
  );
});
