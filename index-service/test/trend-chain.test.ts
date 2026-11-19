import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { signerFromKey } from '@pulse/index-core/attestation.ts';
import { DISCOVERY_V1 } from '@pulse/index-core/discovery.ts';
import { signTrendEpoch } from '@pulse/index-core/trend-epoch.ts';
import { coveragePayload } from '../src/app/trend-coverage.ts';
import {
  publishTrendEpoch,
  readSignedTrendEpoch,
  trendEpochFor,
  trendsDir,
  verifyTrendChain,
} from '../src/app/trend-epoch.ts';
import type { DiscoveryRecord } from '../src/app/discovery.ts';

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signerFromKey(privateKey);
}

function record(day: string, topic: string): DiscoveryRecord {
  return {
    day,
    generatedAt: `${day}T01:00:00.000Z`,
    method: 'wikipedia-top-v1',
    settings: DISCOVERY_V1,
    contextModel: null,
    entries: [
      {
        article: topic,
        topic: topic.replaceAll('_', ' '),
        views: 100_000,
        baseline: 10_000,
        baselineDays: 7,
        momentum: 900,
        link: `https://en.wikipedia.org/wiki/${topic}`,
        imageUrl: null,
        sources: [],
      },
    ],
  };
}

async function tempSnapshots(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pulse-chain-'));
}

test('the first published day starts the chain at genesis', async () => {
  const snapshotsDir = await tempSnapshots();
  const signed = await publishTrendEpoch({
    record: record('2026-11-19', 'A'),
    snapshotsDir,
    signer: signer(),
    now: new Date('2026-11-20T00:00:00Z'),
  });
  assert.equal(signed.trends.prevDigest, 'genesis');
  const chain = await verifyTrendChain(snapshotsDir);
  assert.equal(chain.ok, true);
  assert.equal(chain.chainStart, '2026-11-19');
  assert.deepEqual(chain.problems, []);
});

test('each day commits to the payload hash of the day before it', async () => {
  const snapshotsDir = await tempSnapshots();
  const key = signer();
  const first = await publishTrendEpoch({
    record: record('2026-11-19', 'A'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-20T00:00:00Z'),
  });
  const second = await publishTrendEpoch({
    record: record('2026-11-20', 'B'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-21T00:00:00Z'),
  });
  assert.equal(second.trends.prevDigest, first.attestation.payloadSha256);
  const chain = await verifyTrendChain(snapshotsDir);
  assert.equal(chain.ok, true);
  assert.deepEqual(
    chain.days.map((entry) => entry.day),
    ['2026-11-19', '2026-11-20'],
  );
});

test('a day signed before chaining still anchors the first link', async () => {
  const snapshotsDir = await tempSnapshots();
  const key = signer();
  // The shape every epoch published up to 2026-11-18 has: signed, no link.
  const legacy = signTrendEpoch(trendEpochFor(record('2026-11-18', 'A'), new Date('2026-11-19T00:00:00Z')), key);
  const dir = trendsDir(snapshotsDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '2026-11-18.json'), JSON.stringify(legacy, null, 2));

  const chained = await publishTrendEpoch({
    record: record('2026-11-19', 'B'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-20T00:00:00Z'),
  });
  assert.equal(chained.trends.prevDigest, legacy.attestation.payloadSha256);
  const chain = await verifyTrendChain(snapshotsDir);
  assert.equal(chain.ok, true);
  assert.equal(chain.chainStart, '2026-11-19');
  assert.deepEqual(
    chain.days.map((entry) => [entry.day, entry.prevDigest === null]),
    [
      ['2026-11-18', true],
      ['2026-11-19', false],
    ],
  );
});

test('an edited day breaks the chain even though its own signature is intact', async () => {
  const snapshotsDir = await tempSnapshots();
  const key = signer();
  await publishTrendEpoch({
    record: record('2026-11-19', 'A'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-20T00:00:00Z'),
  });
  await publishTrendEpoch({
    record: record('2026-11-20', 'B'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-21T00:00:00Z'),
  });
  const path = join(trendsDir(snapshotsDir), '2026-11-19.json');
  const body = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const trends = body.trends as { entries: Array<Record<string, unknown>> };
  trends.entries[0]!.views = 1;
  await writeFile(path, JSON.stringify(body, null, 2));

  const chain = await verifyTrendChain(snapshotsDir);
  assert.equal(chain.ok, false);
  assert.match(chain.problems.join('; '), /2026-11-19: signature/);
});

test('a backfilled day exposes the link the later day skipped', async () => {
  const snapshotsDir = await tempSnapshots();
  const key = signer();
  const first = await publishTrendEpoch({
    record: record('2026-11-19', 'A'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-20T00:00:00Z'),
  });
  // 11-20 is missing when 11-21 is signed, so 11-21 commits to 11-19. The
  // backfill is published afterwards with its own valid link. Every signature
  // is genuine; only the order is impossible, which is what the chain catches.
  const third = await publishTrendEpoch({
    record: record('2026-11-21', 'C'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-22T00:00:00Z'),
  });
  const backfilled = await publishTrendEpoch({
    record: record('2026-11-20', 'B'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-22T01:00:00Z'),
  });
  assert.equal(third.trends.prevDigest, first.attestation.payloadSha256);
  assert.equal(backfilled.trends.prevDigest, first.attestation.payloadSha256);

  const chain = await verifyTrendChain(snapshotsDir);
  assert.equal(chain.ok, false);
  assert.match(chain.problems.join('; '), /2026-11-21: commits to/);
});

test('the coverage inventory lists only days that were actually signed', async () => {
  const snapshotsDir = await tempSnapshots();
  const key = signer();
  const first = await publishTrendEpoch({
    record: record('2026-11-19', 'A'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-20T00:00:00Z'),
  });
  await publishTrendEpoch({
    record: record('2026-11-20', 'A'),
    snapshotsDir,
    signer: key,
    now: new Date('2026-11-21T00:00:00Z'),
  });
  // A file without a signature is not coverage, however it got there.
  await writeFile(join(trendsDir(snapshotsDir), '2026-11-21.json'), '{"trends":{},"attestation":{}}');

  const coverage = JSON.parse(await coveragePayload(snapshotsDir)) as {
    days: string[];
    topics: Array<{ article: string; entries: Array<{ day: string; payloadSha256: string }> }>;
  };
  assert.deepEqual(coverage.days, ['2026-11-19', '2026-11-20']);
  assert.equal(coverage.topics.length, 1);
  assert.equal(coverage.topics[0]?.article, 'A');
  assert.equal(coverage.topics[0]?.entries.length, 2);
  assert.equal(coverage.topics[0]?.entries[0]?.payloadSha256, first.attestation.payloadSha256);
});
