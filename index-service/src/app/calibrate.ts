import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ENTITY_BASKET, type EntityDefinition } from '../config/entities.ts';
import { SIGNALS, type SignalDefinition } from '../config/signals.ts';
import { buildDefinition } from './calibration.ts';
import { mapWithConcurrency } from '@pulse/index-core/concurrency.ts';
import { addDays, isValidDay } from '@pulse/index-core/dates.ts';
import type { DailyObservation } from '@pulse/index-core/observation.ts';

const DEFINITIONS_DIR = join(resolve(import.meta.dirname, '..', '..'), 'definitions');

/**
 * Largest range one source accepts in a single request.
 *
 * The Hacker News adapter refuses more than 62 days, so the base period is
 * walked in windows below that rather than shortened to fit.
 */
const BASE_PERIOD_CHUNK_DAYS = 60;

/** Fetches one constituent's whole base period, window by window. */
async function fetchBasePeriod(
  signal: SignalDefinition,
  entity: EntityDefinition,
  startDay: string,
  endDay: string,
  titles?: Readonly<Record<string, string>>,
): Promise<readonly DailyObservation[]> {
  const observations: DailyObservation[] = [];
  let cursor = startDay;
  while (cursor <= endDay) {
    const chunkEnd = addDays(cursor, BASE_PERIOD_CHUNK_DAYS - 1);
    const end = chunkEnd < endDay ? chunkEnd : endDay;
    const fetched = await signal.fetchSeries(entity, cursor, end, titles === undefined ? undefined : { titles });
    observations.push(...fetched.observations);
    cursor = addDays(end, 1);
  }
  return observations.sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Derives a definition from base-period observations and writes it out.
 *
 * Anchors and weights only change here, never during a build, so a published
 * snapshot is reproducible from its own definition plus the day's sources.
 */
export async function calibrate(id: string, baseDay: string, days: number): Promise<void> {
  if (!isValidDay(baseDay)) {
    throw new Error(`invalid --base-day: ${baseDay}`);
  }
  const startDay = addDays(baseDay, -(days - 1));
  const observations = new Map<string, readonly DailyObservation[]>();
  const tasks = SIGNALS.flatMap((signal) =>
    ENTITY_BASKET.map((entity) => ({ signal, entity })),
  );
  // Two tasks at a time: each count task is itself a fan-out of daily requests,
  // and the public APIs throttle bursts harder than they throttle totals.
  const fetched = await mapWithConcurrency(tasks, 2, async ({ signal, entity }) => {
    const titles = signal.resolveTitles === undefined ? undefined : await signal.resolveTitles(entity);
    const series = await fetchBasePeriod(signal, entity, startDay, baseDay, titles);
    console.log(`${signal.id}/${entity.id}: ${series.length} days`);
    return { series, titles };
  });
  const titles = new Map<string, Readonly<Record<string, string>>>();
  tasks.forEach(({ signal, entity }, position) => {
    const entry = fetched[position];
    if (entry === undefined) {
      throw new Error(`calibration lost the fetch for ${signal.id}/${entity.id}`);
    }
    observations.set(`${signal.id}/${entity.id}`, entry.series);
    if (entry.titles !== undefined) {
      titles.set(`${signal.id}/${entity.id}`, entry.titles);
    }
  });

  const definition = buildDefinition({
    id,
    baseDay,
    entities: ENTITY_BASKET,
    signals: SIGNALS,
    observations,
    titles,
    calibrationDays: days,
  });
  await mkdir(DEFINITIONS_DIR, { recursive: true });
  const path = join(DEFINITIONS_DIR, `${id}.json`);
  await writeFile(path, `${JSON.stringify(definition, null, 2)}\n`);
  console.log(`definition ${id} written to ${path}`);
  for (const signal of definition.signals) {
    console.log(`${signal.id}  weight ${signal.weight}`);
    for (const constituent of signal.constituents) {
      console.log(
        `  ${constituent.entityId.padEnd(14)} anchor ${String(constituent.anchor).padStart(10)}` +
          `  weight ${constituent.weight}`,
      );
    }
  }
}
