import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Signer } from '@pulse/index-core/attestation.ts';
import {
  GENESIS_DIGEST,
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
  const epoch: TrendEpoch = {
    ...trendEpochFor(args.record, args.now),
    prevDigest: await previousDigest(trendsDir(args.snapshotsDir), args.record.day),
  };
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

/** Published epochs in the directory, oldest first. */
async function chainedDays(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

/**
 * Digest the new epoch commits to: the most recent earlier payload, or genesis.
 *
 * An earlier epoch that is present but does not verify is a hard error. Chaining
 * past it would publish a record that quietly skips a day, and a skipped day is
 * exactly what the chain exists to make visible.
 */
async function previousDigest(dir: string, day: string): Promise<string> {
  const earlier = (await chainedDays(dir)).filter((published) => published < day);
  const newest = earlier.at(-1);
  if (newest === undefined) return GENESIS_DIGEST;
  const signed = await readSignedTrendEpoch(join(dir, `${newest}.json`));
  if (signed === null) {
    throw new Error(`cannot read ${newest} to chain ${day}`);
  }
  if (!verifySignedTrendEpoch(signed)) {
    throw new Error(`${newest} does not verify, refusing to chain ${day} to it`);
  }
  return signed.attestation.payloadSha256;
}

/** One epoch as the public chain manifest describes it. */
export interface TrendChainDay {
  readonly day: string;
  readonly payloadSha256: string;
  readonly signer: string;
  readonly entries: number;
  /** `legacy` for an epoch signed before chaining started. */
  readonly prevDigest: string | null;
}

export interface TrendChainCheck {
  readonly ok: boolean;
  readonly days: readonly TrendChainDay[];
  /** First day that commits to a predecessor, or null before chaining began. */
  readonly chainStart: string | null;
  /** Every broken link, unverifiable epoch or gap, in day order. */
  readonly problems: readonly string[];
}

/**
 * Walks the published epochs and checks that each one commits to the last.
 *
 * A signature proves a day was signed by the key. Only the link from each day
 * to its predecessor proves the order, and order is what stops a day from being
 * inserted or swapped after a market has settled on it.
 */
export async function verifyTrendChain(snapshotsDir: string): Promise<TrendChainCheck> {
  const dir = trendsDir(snapshotsDir);
  const days = await chainedDays(dir);
  const chain: TrendChainDay[] = [];
  const problems: string[] = [];
  let chainStart: string | null = null;
  let previous: TrendChainDay | null = null;
  for (const day of days) {
    const signed = await readSignedTrendEpoch(join(dir, `${day}.json`));
    if (signed === null) {
      problems.push(`${day}: unreadable`);
      continue;
    }
    if (signed.trends.epochDay !== day) {
      problems.push(`${day}: document claims ${signed.trends.epochDay}`);
    }
    if (!verifySignedTrendEpoch(signed)) {
      problems.push(`${day}: signature or definition digest does not verify`);
      continue;
    }
    const prevDigest = signed.trends.prevDigest ?? null;
    if (prevDigest === null) {
      if (chainStart !== null) {
        problems.push(`${day}: signed after chaining began but commits to nothing`);
      }
    } else {
      if (chainStart === null) chainStart = day;
      // The first chained day may point at an epoch signed before chaining
      // began: that day still has a payload hash, so the link is checkable.
      const expected = previous === null ? GENESIS_DIGEST : previous.payloadSha256;
      if (prevDigest !== expected) {
        const why =
          previous === null
            ? 'the chain starts at genesis'
            : `${previous.day} is ${previous.payloadSha256}`;
        problems.push(`${day}: commits to ${prevDigest}, but ${why}`);
      }
    }
    const current: TrendChainDay = {
      day,
      payloadSha256: signed.attestation.payloadSha256,
      signer: signed.attestation.publicKey,
      entries: signed.trends.entries.length,
      prevDigest,
    };
    chain.push(current);
    previous = current;
  }
  return { ok: problems.length === 0, days: chain, chainStart, problems };
}

/** The published chain manifest: one line per epoch and every broken link. */
export function chainManifest(check: TrendChainCheck): string {
  return JSON.stringify(
    {
      schema: 'pulse-trends-chain/1',
      chainStart: check.chainStart,
      ok: check.ok,
      problems: check.problems,
      days: check.days,
    },
    null,
    2,
  );
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
