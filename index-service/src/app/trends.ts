import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntityDefinition } from '../config/entities.ts';
import { ENTITY_IMAGES } from '../config/entity-images.ts';
import { addDays } from '../domain/dates.ts';
import { MOMENTUM_WINDOW_DAYS } from '../domain/momentum.ts';
import type { EntityScore } from '../domain/scoring.ts';
import type { IndexSnapshot, SignalSeries } from '../domain/snapshot.ts';
import { readDiscovery } from './discovery.ts';

/** How attention is moving for one entity, in the shape the landing page reads. */
export type TrendStatus = 'surging' | 'trending' | 'stable' | 'fading';

export interface TrendSource {
  /** Names the page already understands: wikipedia, hackernews. */
  readonly source: string;
  /** Raw target-day count for this signal, as published in the snapshot. */
  readonly volume: number;
  /** A page a reader can open to check the signal themselves. */
  readonly link: string;
}

export interface Trend {
  readonly id: string;
  readonly topic: string;
  readonly hashtag: string;
  readonly status: TrendStatus;
  /** Percent change in attention level over the momentum window, null if unmeasured. */
  readonly momentum: number | null;
  readonly sourceCount: number;
  readonly sources: readonly TrendSource[];
  readonly imageUrl?: string;
  /** True for a topic the daily ranking surfaced rather than the signed basket. */
  readonly discovered?: boolean;
  /** Mean daily views over the comparison window, for discovered topics. */
  readonly baseline?: number;
  /** Days averaged into the baseline, for discovered topics. */
  readonly baselineDays?: number;
}

/** Snapshot ids to the source names the page knows. */
const SOURCE_NAMES: Readonly<Record<string, string>> = {
  'wikipedia-pageviews': 'wikipedia',
  'hacker-news-stories': 'hackernews',
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Bands are deliberately coarse. A card says the attention is surging or fading,
 * which is a claim the data can carry; it does not pretend to price a trend.
 */
export function statusFor(momentum: number | null): TrendStatus {
  if (momentum === null) {
    return 'stable';
  }
  if (momentum >= 10) {
    return 'surging';
  }
  if (momentum >= 2) {
    return 'trending';
  }
  if (momentum > -2) {
    return 'stable';
  }
  return 'fading';
}

/** Wikipedia article and Hacker News search, for a reader to verify a signal. */
function sourceLink(signal: string, entity: EntityDefinition): string {
  if (signal === 'wikipedia-pageviews') {
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(
      entity.wikipediaArticle.replaceAll(' ', '_'),
    )}`;
  }
  return `https://hn.algolia.com/?q=${encodeURIComponent(entity.hackerNewsQuery)}`;
}

function scored(score: EntityScore | undefined): score is Extract<EntityScore, { status: 'scored' }> {
  return score?.status === 'scored';
}

function levelOf(series: SignalSeries | undefined, entityId: string): number | null {
  const score = series?.entities.find((entry) => entry.entityId === entityId);
  return scored(score) ? score.level : null;
}

/**
 * Percent change in attention level for one entity across the window.
 *
 * Averaged over the signals that scored in both epochs, not summed, so an entity
 * measured by one signal is not scaled down against one measured by two. Returns
 * null when no signal can be compared, because a made-up zero would render as
 * "flat" and that is a measurement this data does not have.
 */
export function momentumFor(
  entityId: string,
  current: IndexSnapshot,
  reference: IndexSnapshot | null,
): number | null {
  if (reference === null) {
    return null;
  }
  const changes: number[] = [];
  for (const series of current.series) {
    const before = reference.series.find((entry) => entry.id === series.id);
    const now = levelOf(series, entityId);
    const was = levelOf(before, entityId);
    if (now === null || was === null || was <= 0) {
      continue;
    }
    changes.push(((now - was) / was) * 100);
  }
  if (changes.length === 0) {
    return null;
  }
  return round1(changes.reduce((total, value) => total + value, 0) / changes.length);
}

/**
 * Turns published snapshots into the landing page's trend list.
 *
 * One trend per basket entity that scored in the current epoch, so a card always
 * has a measured number behind it. Entities the basket cannot currently measure
 * are left out rather than shown as flat.
 */
export function buildTrends(
  current: IndexSnapshot,
  reference: IndexSnapshot | null,
  basket: readonly EntityDefinition[],
): readonly Trend[] {
  const trends: Trend[] = [];
  for (const entity of basket) {
    const sources: TrendSource[] = [];
    for (const series of current.series) {
      const score = series.entities.find((entry) => entry.entityId === entity.id);
      const name = SOURCE_NAMES[series.id];
      if (!scored(score) || name === undefined) {
        continue;
      }
      sources.push({
        source: name,
        volume: score.value,
        link: sourceLink(series.id, entity),
      });
    }
    if (sources.length === 0) {
      continue;
    }
    const momentum = momentumFor(entity.id, current, reference);
    const image = ENTITY_IMAGES[entity.id];
    trends.push({
      id: entity.id,
      topic: entity.label,
      hashtag: entity.label,
      status: statusFor(momentum),
      momentum,
      sourceCount: sources.length,
      sources,
      ...(image === undefined ? {} : { imageUrl: image }),
    });
  }
  return trends.sort((a, b) => (b.momentum ?? -1000) - (a.momentum ?? -1000));
}

interface SnapshotFile {
  readonly snapshot?: IndexSnapshot;
}

async function readSnapshot(snapshotsDir: string, day: string): Promise<IndexSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(join(snapshotsDir, `${day}.json`), 'utf8')) as SnapshotFile;
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

async function latestSnapshot(snapshotsDir: string): Promise<IndexSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(join(snapshotsDir, 'latest.json'), 'utf8')) as SnapshotFile;
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * The payload behind /api/trends: trends plus the epoch they describe.
 *
 * The header travels with the data so the page can say which day it is showing
 * instead of "updated live", which claims more than a daily epoch can support.
 */
export async function trendsPayload(args: {
  readonly snapshotsDir: string;
  readonly basket: readonly EntityDefinition[];
}): Promise<string> {
  const current = await latestSnapshot(args.snapshotsDir);
  if (current === null) {
    return JSON.stringify({ trends: [], epochDay: null, reason: 'no-snapshot' });
  }
  const referenceDay = current.momentum?.referenceDay ?? addDays(current.epochDay, -MOMENTUM_WINDOW_DAYS);
  const reference = await readSnapshot(args.snapshotsDir, referenceDay);
  const discovery = await readDiscovery(args.snapshotsDir, current.epochDay);
  const discovered: Trend[] = (discovery?.entries ?? []).map((entry) => ({
    id: `wiki:${entry.article}`,
    topic: entry.topic,
    hashtag: entry.topic,
    status: statusFor(entry.momentum),
    momentum: entry.momentum,
    sourceCount: 1,
    sources: [{ source: 'wikipedia', volume: entry.views, link: entry.link }],
    discovered: true,
    baseline: entry.baseline,
    baselineDays: entry.baselineDays,
    ...(entry.imageUrl === null ? {} : { imageUrl: entry.imageUrl }),
  }));
  return JSON.stringify({
    trends: [...buildTrends(current, reference, args.basket), ...discovered],
    discovery:
      discovery === null
        ? null
        : {
            day: discovery.day,
            method: discovery.method,
            minViews: discovery.settings.minViews,
            minMomentum: discovery.settings.minMomentum,
          },
    epochDay: current.epochDay,
    definitionId: current.definitionId,
    confidence: current.coverage.confidence,
    index: current.index.score,
    momentum: current.momentum?.score ?? null,
    referenceDay: reference === null ? null : referenceDay,
    generatedAt: current.generatedAt,
  });
}
