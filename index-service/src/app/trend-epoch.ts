import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Signer } from '@pulse/index-core/attestation.ts';
import {
  signTrendEpoch,
  TREND_DEFINITION_ID,
  TREND_EPOCH_SCHEMA,
  trendDefinitionDigest,
  verifySignedTrendEpoch,
  type SignedTrendEpoch,
  type TrendEpoch,
} from '@pulse/index-core/trend-epoch.ts';
import type { DiscoveryRecord } from './discovery.ts';

/** Signed trend epochs are kept beside the index snapshots. */
export function trendsDir(snapshotsDir: string): string {
  return join(snapshotsDir, 'trends');
}

/**
 * Lifts a discovery record into the settlement document.
 *
 * The numbers are copied, not recomputed: a signed epoch must describe the same
 * measurement the page shows, so a later change to discovery settings creates a
 * new epoch rather than silently editing this one.
 */
export function trendEpochFor(record: DiscoveryRecord, now: Date): TrendEpoch {
  return {
    schema: TREND_EPOCH_SCHEMA,
    epochDay: record.day,
    generatedAt: now.toISOString(),
    method: record.method,
    definitionId: TREND_DEFINITION_ID,
    definitionSha256: trendDefinitionDigest(record.method, record.settings),
    settings: record.settings,
    entries: record.entries.map((entry) => ({
      article: entry.article,
      topic: entry.topic,
      views: entry.views,
      baseline: entry.baseline,
      baselineDays: entry.baselineDays,
      momentum: entry.momentum,
      sources: entry.sources,
      ...(entry.via === undefined ? {} : { via: entry.via }),
    })),
  };
}

/**
 * Signs and writes one day, with a self-check before anything hits disk.
 *
 * The self-check is the same one the index build uses: a signature that cannot
 * verify is a bug, and publishing it would hand markets unusable evidence.
 */
export async function publishTrendEpoch(args: {
  readonly record: DiscoveryRecord;
  readonly snapshotsDir: string;
  readonly signer: Signer;
  readonly now: Date;
}): Promise<SignedTrendEpoch> {
  const epoch = trendEpochFor(args.record, args.now);
  const signed = signTrendEpoch(epoch, args.signer);
  if (!verifySignedTrendEpoch(signed)) {
    throw new Error('trend signature self-check failed, refusing to publish');
  }
  const dir = trendsDir(args.snapshotsDir);
  await mkdir(dir, { recursive: true });
  const body = JSON.stringify(signed, null, 2);
  await writeFile(join(dir, `${epoch.epochDay}.json`), body);
  await writeFile(join(dir, 'latest.json'), body);
  return signed;
}

/** Reads one signed epoch, or null when it was never published. */
export async function readSignedTrendEpoch(path: string): Promise<SignedTrendEpoch | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SignedTrendEpoch>;
    if (parsed.trends === undefined || parsed.attestation === undefined) {
      return null;
    }
    return parsed as SignedTrendEpoch;
  } catch {
    return null;
  }
}

export type TrendVerifyResult =
  | {
      readonly ok: true;
      readonly epochDay: string;
      readonly signer: string;
      readonly entries: number;
      readonly payloadSha256: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Verifies the signature and that the embedded terms match the digest.
 *
 * This does not refetch the sources. That is a separate audit; settlement only
 * needs to know that the published numbers were signed under the pinned rule.
 */
export async function verifyTrendEpoch(args: {
  readonly snapshotsDir: string;
  readonly day?: string;
}): Promise<TrendVerifyResult> {
  const path =
    args.day === undefined
      ? join(trendsDir(args.snapshotsDir), 'latest.json')
      : join(trendsDir(args.snapshotsDir), `${args.day}.json`);
  const signed = await readSignedTrendEpoch(path);
  if (signed === null) {
    return { ok: false, error: `no signed trend epoch at ${path}` };
  }
  if (args.day !== undefined && signed.trends.epochDay !== args.day) {
    return { ok: false, error: `epoch is ${signed.trends.epochDay}, expected ${args.day}` };
  }
  if (!verifySignedTrendEpoch(signed)) {
    return { ok: false, error: 'signature or definition digest does not verify' };
  }
  return {
    ok: true,
    epochDay: signed.trends.epochDay,
    signer: signed.attestation.publicKey,
    entries: signed.trends.entries.length,
    payloadSha256: signed.attestation.payloadSha256,
  };
}
