import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { verifySignedTrendEpoch, type SignedTrendEpoch } from '@pulse/index-core/trend-epoch.ts';
import { trendsDir } from './trend-epoch.ts';

/** One attested appearance of a topic, with the day that proves it. */
export interface CoverageEntry {
  readonly day: string;
  readonly topic: string;
  readonly momentum: number;
  readonly views: number;
  readonly payloadSha256: string;
}

export interface CoverageTopic {
  readonly article: string;
  readonly topic: string;
  /** Attested days, oldest first. A market needs one of these to settle. */
  readonly entries: readonly CoverageEntry[];
}

export interface CoverageDocument {
  readonly schema: 'pulse-trends-coverage/1';
  readonly days: readonly string[];
  readonly topics: readonly CoverageTopic[];
}

/**
 * What a market could settle on today, read only from signed epochs.
 *
 * An integrator choosing markets needs the inventory, not the prose: which
 * topics have an attested day, on which day, under which payload hash. Built
 * from the signed files so nothing here can promise a topic the record will not
 * stand behind.
 */
export async function coveragePayload(snapshotsDir: string): Promise<string> {
  const dir = trendsDir(snapshotsDir);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const days = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort();

  const byArticle = new Map<string, { topic: string; entries: CoverageEntry[] }>();
  const covered: string[] = [];
  for (const day of days) {
    let signed: SignedTrendEpoch;
    try {
      signed = JSON.parse(await readFile(join(dir, `${day}.json`), 'utf8')) as SignedTrendEpoch;
      // Coverage is a promise about what can be settled, so it only counts days
      // whose signature and terms verify. A malformed file is skipped, not a
      // crash for every reader of the inventory.
      if (!verifySignedTrendEpoch(signed)) {
        continue;
      }
    } catch {
      continue;
    }
    covered.push(day);
    for (const entry of signed.trends.entries) {
      const current = byArticle.get(entry.article) ?? { topic: entry.topic, entries: [] };
      current.entries.push({
        day,
        topic: entry.topic,
        momentum: entry.momentum,
        views: entry.views,
        payloadSha256: signed.attestation.payloadSha256,
      });
      byArticle.set(entry.article, current);
    }
  }

  const document: CoverageDocument = {
    schema: 'pulse-trends-coverage/1',
    days: covered,
    topics: [...byArticle]
      .map(([article, value]) => ({ article, topic: value.topic, entries: value.entries }))
      .sort((a, b) => b.entries.length - a.entries.length || a.article.localeCompare(b.article)),
  };
  return JSON.stringify(document, null, 2);
}
