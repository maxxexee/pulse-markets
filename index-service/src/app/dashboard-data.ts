import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidDay } from '@pulse/index-core/dates.ts';
import type { IndexSnapshot } from '@pulse/index-core/snapshot.ts';

/**
 * The dashboard reads one generated script, not the JSON routes, so the numbers
 * it shows have to be built from the same signed snapshots the rest of the site
 * serves. Generating it here means the export cannot publish a signed epoch
 * beside a dashboard that still shows an older day.
 *
 * Everything is presentation: no score, weight or settlement term is recomputed
 * here. A file that does not parse is skipped rather than failing the export,
 * because one unreadable market spec must not keep the site offline.
 */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export interface DashboardDataOptions {
  readonly snapshotsDir: string;
  readonly marketsDir: string;
  /** The app's image directory, so a constituent's lead image is found by name. */
  readonly imagesDir: string;
}

interface HistoryEntity {
  readonly value: number;
  readonly baseline: number;
  readonly level: number;
  readonly score: number;
}

interface HistoryDay {
  readonly day: string;
  readonly score: number | null;
  readonly definitionId: string;
  readonly entities: Record<string, HistoryEntity>;
}

interface DiscoveryEntryLike {
  readonly topic: string;
  readonly [key: string]: unknown;
}

interface DiscoveryRecordLike {
  readonly day: string;
  readonly contextModel?: string | null;
  readonly entries: readonly DiscoveryEntryLike[];
}

interface MarketSpec {
  readonly epochDay?: string;
  readonly definitionId?: string;
  readonly [key: string]: unknown;
}

async function jsonFiles(dir: string, pattern: RegExp): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).filter((name) => pattern.test(name)).sort();
  } catch {
    return [];
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Signed epochs, oldest first, read as `snapshot` payloads. */
async function snapshotDays(snapshotsDir: string): Promise<readonly (HistoryDay & { snapshot: IndexSnapshot })[]> {
  const names = await jsonFiles(snapshotsDir, DAY_FILE);
  const days: Array<HistoryDay & { snapshot: IndexSnapshot }> = [];
  for (const name of names) {
    const day = name.slice(0, 10);
    if (!isValidDay(day)) continue;
    const parsed = await readJson<{ snapshot?: IndexSnapshot }>(join(snapshotsDir, name));
    const snapshot = parsed?.snapshot;
    if (snapshot === undefined) continue;
    const entities: Record<string, HistoryEntity> = {};
    for (const entity of snapshot.series[0]?.entities ?? []) {
      if (entity.status !== 'scored') continue;
      entities[entity.entityId] = {
        value: entity.value,
        baseline: entity.baseline,
        level: entity.level,
        score: entity.score,
      };
    }
    days.push({
      day,
      score: snapshot.index.score,
      definitionId: snapshot.definitionId,
      entities,
      snapshot,
    });
  }
  return days;
}

/**
 * The newest signed snapshot the site should advertise.
 *
 * `latest.json` is written by the build, but a checkout can carry day files
 * without it, so the newest day file is the fallback.
 */
async function latestSnapshot(
  snapshotsDir: string,
  days: readonly { day: string; snapshot: IndexSnapshot }[],
): Promise<IndexSnapshot | null> {
  const latest = await readJson<{ snapshot?: IndexSnapshot }>(join(snapshotsDir, 'latest.json'));
  if (latest?.snapshot !== undefined) {
    return latest.snapshot;
  }
  return days.at(-1)?.snapshot ?? null;
}

/** Every published board, newest first, so an archived topic keeps its page. */
async function trendDays(snapshotsDir: string): Promise<readonly DiscoveryRecordLike[]> {
  const dir = join(snapshotsDir, 'discovery');
  const names = await jsonFiles(dir, DAY_FILE);
  const boards: DiscoveryRecordLike[] = [];
  for (const name of names) {
    const record = await readJson<DiscoveryRecordLike>(join(dir, name));
    if (record !== null) boards.push(record);
  }
  return boards.reverse();
}

/** Constituent lead images, keyed by entity id, as the dashboard names them. */
async function entityImages(imagesDir: string): Promise<Record<string, string>> {
  const names = await jsonFiles(imagesDir, /^e-.+\.jpg$/);
  const map: Record<string, string> = {};
  for (const name of names) {
    map[name.slice(2, -4)] = name;
  }
  return map;
}

/** Market specs joined with the epoch score they resolve against. */
async function markets(marketsDir: string, history: readonly HistoryDay[]): Promise<readonly unknown[]> {
  const names = await jsonFiles(marketsDir, /\.json$/);
  const joined: unknown[] = [];
  for (const name of names) {
    const spec = await readJson<MarketSpec>(join(marketsDir, name));
    if (spec === null) continue;
    const sameDay = history.find((row) => row.day === spec.epochDay);
    joined.push({
      spec,
      epochScore: sameDay?.score ?? null,
      epochDefinition: sameDay?.definitionId ?? null,
      definitionMatches:
        sameDay !== undefined && spec.definitionId !== undefined && sameDay.definitionId === spec.definitionId,
    });
  }
  return joined;
}

const compact = (value: unknown): string => JSON.stringify(value);

/**
 * Writes the script the dashboard loads.
 *
 * The globals are the same ones the page already reads, so nothing about the
 * dashboard had to change to stop it going stale.
 */
export async function dashboardData(options: DashboardDataOptions): Promise<string> {
  const snapshots = await snapshotDays(options.snapshotsDir);
  const latest = await latestSnapshot(options.snapshotsDir, snapshots);
  if (latest === null) {
    throw new Error('no signed snapshot to build the dashboard data from');
  }
  const history: HistoryDay[] = snapshots.map(({ snapshot: _snapshot, ...row }) => row);
  const boards = await trendDays(options.snapshotsDir);
  const discovery = boards[0] ?? { day: (latest.epochDay ?? '').slice(0, 10), entries: [] };
  return [
    '// PULSE data — generated by the export from the signed snapshots, do not edit.',
    `window.PULSE_INDEX = ${compact(latest)};`,
    `window.PULSE_INDEX_HISTORY = ${compact(history)};`,
    `window.PULSE_MARKETS = ${compact(await markets(options.marketsDir, history))};`,
    `window.PULSE_DISCOVERY = ${compact(discovery)};`,
    `window.PULSE_TREND_DAYS = ${compact(boards)};`,
    `window.PULSE_IMGS = ${compact(await entityImages(options.imagesDir))};`,
    '',
  ].join('\n');
}
