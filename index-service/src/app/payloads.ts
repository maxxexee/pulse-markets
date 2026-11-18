import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntityDefinition } from '../config/entities.ts';
import { coverageRatioOf } from '../domain/coverage.ts';
import { isValidDay } from '../domain/dates.ts';
import type { IndexSnapshot } from '../domain/snapshot.ts';

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function articleUrl(article: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(article.replaceAll(' ', '_'))}`;
}

/** The basket and where each entity can be checked, for the methods section. */
export function basketPayload(basket: readonly EntityDefinition[]): string {
  return JSON.stringify({
    entities: basket.map((entity) => ({
      id: entity.id,
      label: entity.label,
      wikipediaUrl: articleUrl(entity.wikipediaArticle),
      hackerNewsQuery: entity.hackerNewsQuery,
    })),
  });
}

/**
 * Published market specs, read from a directory of JSON files.
 *
 * The index service does not validate these: terms are the resolver's business,
 * and settlement is where a bad spec is refused. An unreadable file is named in
 * the payload rather than dropped, so a missing card is explainable.
 */
export async function marketsPayload(marketsDir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(marketsDir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return JSON.stringify({ markets: [], unreadable: [] });
  }
  const markets: unknown[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    try {
      markets.push(JSON.parse(await readFile(join(marketsDir, name), 'utf8')));
    } catch {
      unreadable.push(name);
    }
  }
  return JSON.stringify({ markets, unreadable });
}

/** One row per published epoch, oldest first, for the history chart. */
export async function historyPayload(snapshotsDir: string): Promise<string> {
  let names: string[];
  try {
    names = await readdir(snapshotsDir);
  } catch {
    return JSON.stringify({ days: [] });
  }
  const published = names
    .map((name) => DAY_FILE.exec(name)?.[1])
    .filter((day): day is string => day !== undefined && isValidDay(day))
    .sort();

  const days: unknown[] = [];
  for (const day of published) {
    try {
      const raw = await readFile(join(snapshotsDir, `${day}.json`), 'utf8');
      const parsed = JSON.parse(raw) as { snapshot?: IndexSnapshot };
      const snapshot = parsed.snapshot;
      if (snapshot === undefined) {
        continue;
      }
      days.push({
        day,
        index: snapshot.index.score,
        momentum: snapshot.momentum === null ? null : snapshot.momentum.score,
        coverageRatio: coverageRatioOf(snapshot.coverage) ?? 0,
        seriesScored: snapshot.coverage.seriesScored,
        seriesExpected: snapshot.coverage.seriesExpected,
      });
    } catch {
      continue;
    }
  }
  return JSON.stringify({ days });
}
