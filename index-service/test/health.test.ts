import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TEST_DEFINITION, TEST_DEFINITION_SHA256 } from './definition-fixture.ts';
import { signSnapshot, signerFromKey } from '../src/adapters/attestation.ts';
import { readSnapshotHealth } from '../src/adapters/health.ts';
import { assessHealth, isHealthy, type PublishedSnapshotView } from '../src/domain/health.ts';
import { SNAPSHOT_SCHEMA, type IndexSnapshot } from '../src/domain/snapshot.ts';

const NOW = new Date('2026-11-17T09:15:00Z');
const YESTERDAY = '2026-11-16';

const view = (epochDay: string): PublishedSnapshotView => ({
  epochDay,
  indexScore: 58.11,
  confidence: 0.8571,
  weightScored: 0.8571,
  signer: 'BDFyypNLd5eGdxSjtCUGasgjZm1MFU6WBAbpt1c6ncmc',
  payloadSha256: 'a'.repeat(64),
});

const health = (epochDay: string | null, options: { valid?: boolean; maxAgeDays?: number } = {}) =>
  assessHealth({
    latest: epochDay === null ? null : view(epochDay),
    signatureValid: options.valid ?? true,
    today: '2026-11-17',
    maxAgeDays: options.maxAgeDays ?? 1,
    now: NOW,
  });

test('a snapshot for the previous UTC day is healthy', () => {
  const report = health(YESTERDAY);
  assert.equal(report.status, 'ok');
  assert.equal(isHealthy(report), true);
  assert.equal(report.ageDays, 0);
  assert.equal(report.expectedEpochDay, YESTERDAY);
  assert.match(report.detail, /is current/);
});

test('one day of lag is tolerated, because today may not have been built yet', () => {
  const report = health('2026-11-15');
  assert.equal(report.status, 'ok');
  assert.equal(report.ageDays, 1);
  assert.match(report.detail, /within the 1 day limit/);
});

test('two days of lag is stale', () => {
  const report = health('2026-11-14');
  assert.equal(report.status, 'stale');
  assert.equal(isHealthy(report), false);
  assert.equal(report.ageDays, 2);
  assert.match(report.detail, /2 days behind/);
});

test('the age limit is configurable', () => {
  assert.equal(health('2026-11-14', { maxAgeDays: 2 }).status, 'ok');
  assert.equal(health('2026-11-13', { maxAgeDays: 2 }).status, 'stale');
});

test('no snapshot at all is missing, not stale', () => {
  const report = health(null);
  assert.equal(report.status, 'missing');
  assert.equal(report.epochDay, null);
  assert.equal(report.ageDays, null);
  assert.match(report.detail, /no published snapshot/);
});

test('a snapshot that does not verify is reported as unverified even when fresh', () => {
  const report = health(YESTERDAY, { valid: false });
  assert.equal(report.status, 'unverified');
  assert.equal(report.epochDay, YESTERDAY);
  assert.match(report.detail, /does not verify/);
});

test('verification outranks staleness, so a tampered old file is not called stale', () => {
  assert.equal(health('2026-10-01', { valid: false }).status, 'unverified');
});

test('an impossible age limit is refused', () => {
  assert.throws(() => health(YESTERDAY, { maxAgeDays: -1 }), /invalid max age/);
});

test('an invalid today is refused', () => {
  assert.throws(() =>
    assessHealth({ latest: null, signatureValid: false, today: '2026-13-01', maxAgeDays: 1, now: NOW }),
  );
});

function fixtureSnapshot(epochDay: string): IndexSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    epochDay,
    generatedAt: '2026-11-17T00:00:00.000Z',
    definitionId: TEST_DEFINITION.id,
    definition: TEST_DEFINITION,
    definitionSha256: TEST_DEFINITION_SHA256,
    index: { score: 58.11, scoredEntities: 12, totalEntities: 14 },
    momentum: null,
    coverage: {
      signalsScored: 2,
      signalsTotal: 2,
      seriesScored: 12,
      seriesExpected: 14,
      confidence: 0.8571,
      weightScored: 0.8571,
      oldestSourceAt: '2026-11-16T23:21:15.023Z',
    },
    series: [],
    sources: [],
  };
}

async function withSnapshots(
  files: Readonly<Record<string, string>>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-health-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(dir, name), contents);
    }
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the adapter reads and verifies a published snapshot', async () => {
  const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
  const signed = signSnapshot(fixtureSnapshot(YESTERDAY), signer);
  await withSnapshots({ 'latest.json': JSON.stringify(signed) }, async (dir) => {
    const report = await readSnapshotHealth({ snapshotsDir: dir, now: NOW });
    assert.equal(report.status, 'ok');
    assert.equal(report.epochDay, YESTERDAY);
    assert.equal(report.signer, signer.publicKey);
    assert.equal(report.indexScore, 58.11);
  });
});

test('a tampered payload is reported as unverified by the adapter', async () => {
  const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
  const signed = signSnapshot(fixtureSnapshot(YESTERDAY), signer);
  const tampered = { ...signed, snapshot: { ...signed.snapshot, index: { ...signed.snapshot.index, score: 99 } } };
  await withSnapshots({ 'latest.json': JSON.stringify(tampered) }, async (dir) => {
    assert.equal((await readSnapshotHealth({ snapshotsDir: dir, now: NOW })).status, 'unverified');
  });
});

test('a missing file and a malformed file both report as missing', async () => {
  await withSnapshots({}, async (dir) => {
    assert.equal((await readSnapshotHealth({ snapshotsDir: dir, now: NOW })).status, 'missing');
  });
  await withSnapshots({ 'latest.json': '{"not":"a snapshot"}' }, async (dir) => {
    assert.equal((await readSnapshotHealth({ snapshotsDir: dir, now: NOW })).status, 'missing');
  });
});
