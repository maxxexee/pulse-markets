import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadOrCreateSigner, signSnapshot, verifySignedSnapshot } from './adapters/attestation.ts';
import { AUTH_CLIENT_SOURCE, buildAuthClient } from './app/auth-bundle.ts';
import { buildSnapshot } from './app/build-snapshot.ts';
import { calibrate } from './app/calibrate.ts';
import { refreshDiscovery as refreshDiscoveryRecord } from './app/discovery.ts';
import { startServer } from './app/server.ts';
import { verifyDay } from './app/verify.ts';
import { fetchSocialPanel, SOCIAL_KEY_ENV } from './adapters/twitter.ts';
import { DEFAULT_MAX_AGE_DAYS, readSnapshotHealth } from './adapters/health.ts';
import { basketPayload, historyPayload, marketsPayload } from './app/payloads.ts';
import { trendsPayload } from './app/trends.ts';
import { ENTITY_BASKET } from './config/entities.ts';
import { ACTIVE_DEFINITION_ID, CALIBRATION_DAYS } from './config/index-definition.ts';
import { socialQuery } from './config/social.ts';
import type { IndexDefinition } from '@pulse/index-core/index-definition.ts';
import { MIN_PUBLISH_CONFIDENCE } from '@pulse/index-core/coverage.ts';
import { addDays, isValidDay, toDay } from '@pulse/index-core/dates.ts';
import { MOMENTUM_WINDOW_DAYS } from '@pulse/index-core/momentum.ts';
import { missingEpochDays } from '@pulse/index-core/schedule.ts';
import type { IndexSnapshot } from '@pulse/index-core/snapshot.ts';

const SERVICE_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(SERVICE_ROOT, '..');
const SNAPSHOTS_DIR = join(SERVICE_ROOT, 'snapshots');
const DEFINITIONS_DIR = join(SERVICE_ROOT, 'definitions');
const KEY_PATH = join(SERVICE_ROOT, '.keys', 'index-signer.pem');
const PUBLIC_DIR = join(SERVICE_ROOT, 'public');
const MARKETS_DIR = join(SERVICE_ROOT, '..', 'markets');
const APP_DIR = join(SERVICE_ROOT, '..', 'app');

const USAGE = `pulse index-service

  build [--day YYYY-MM-DD] [--catch-up N] [--force] [--definition ID]
                             compute, sign and publish an epoch snapshot
  calibrate [--id ID] [--base-day YYYY-MM-DD] [--days N]
                             derive anchors and weights from base-period data and
                             write the published definition to definitions/
  discover [--day YYYY-MM-DD]
                             regenerate the trending topics beside the index
  export --out DIR          write the site and its JSON as plain files
  health [--max-age-days N]  report whether the latest snapshot is current
  social                     fetch the display-only social panel, if configured
  serve [--port N] [--max-age-days N]
                             serve the public index and the latest snapshot
  verify [--day YYYY-MM-DD]  recompute a published epoch from its sources and
                             compare it with the signed snapshot

Days are UTC. build defaults to the previous UTC day. A day that is already
published is left alone unless --force is given, so a rerun never replaces a
signed epoch. --catch-up N publishes every day in the trailing N-day window that
has no snapshot yet, which is what a scheduled run uses after a skipped day.
social reads its key from ${SOCIAL_KEY_ENV} and never affects the index.`;

/** Days that already have a published snapshot, oldest first. */
async function publishedDays(): Promise<readonly string[]> {
  try {
    const names = await readdir(SNAPSHOTS_DIR);
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Reads the snapshot for the momentum reference day, if it was published.
 *
 * Missing history is normal (a fresh deployment, a skipped day), so this
 * returns null and the build publishes null momentum instead of failing.
 */
async function loadReference(day: string): Promise<IndexSnapshot | null> {
  try {
    const raw = await readFile(join(SNAPSHOTS_DIR, `${day}.json`), 'utf8');
    const parsed = JSON.parse(raw) as { snapshot?: IndexSnapshot };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads a published definition from disk.
 *
 * Builds refuse to run without one: falling back to defaults would publish a
 * level under terms nobody can reproduce.
 */
async function loadDefinition(id: string): Promise<IndexDefinition> {
  const path = join(DEFINITIONS_DIR, `${id}.json`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`no published definition at ${path}; run calibrate first`);
  }
  const definition = JSON.parse(text) as IndexDefinition;
  if (definition.id !== id) {
    throw new Error(`${path} defines ${definition.id}, expected ${id}`);
  }
  return definition;
}

async function build(day: string, force: boolean, definitionId: string): Promise<void> {
  if (!isValidDay(day)) {
    throw new Error(`invalid --day: ${day}`);
  }

  const dayPath = join(SNAPSHOTS_DIR, `${day}.json`);
  if (!force && existsSync(dayPath)) {
    console.log(`epoch ${day} already published, leaving it untouched (--force to replace)`);
    return;
  }

  const newestPublished = (await publishedDays()).at(-1) ?? null;
  const reference = await loadReference(addDays(day, -MOMENTUM_WINDOW_DAYS));
  const definition = await loadDefinition(definitionId);
  const snapshot = await buildSnapshot({
    entities: ENTITY_BASKET,
    definition,
    targetDay: day,
    now: new Date(),
    history: reference === null ? [] : [reference],
  });

  const coverage = snapshot.coverage;
  if (coverage.coverageRatio < MIN_PUBLISH_CONFIDENCE) {
    throw new Error(
      `refusing to publish ${day}: coverage ${coverage.coverageRatio} is below the ` +
        `${MIN_PUBLISH_CONFIDENCE} floor (${coverage.seriesScored}/${coverage.seriesExpected} series). ` +
        'A source has probably not published this day yet; retry later.',
    );
  }

  const signed = signSnapshot(snapshot, loadOrCreateSigner(KEY_PATH));
  if (!verifySignedSnapshot(signed)) {
    throw new Error('signature self-check failed, refusing to publish');
  }

  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const body = JSON.stringify(signed, null, 2);
  await writeFile(dayPath, body);
  if (newestPublished === null || day >= newestPublished) {
    await writeFile(join(SNAPSHOTS_DIR, 'latest.json'), body);
  }

  console.log(`epoch ${day}  index ${snapshot.index.score ?? 'n/a'}`);
  const momentum = snapshot.momentum;
  console.log(
    momentum === null
      ? `momentum n/a (no snapshot for ${addDays(day, -MOMENTUM_WINDOW_DAYS)} under these terms)`
      : `momentum ${momentum.score} (${momentum.delta >= 0 ? '+' : ''}${momentum.delta} points over ${momentum.windowDays}d)`,
  );
  console.log(
    `coverage ${coverage.seriesScored}/${coverage.seriesExpected} series` +
      `, ${coverage.signalsScored}/${coverage.signalsTotal} signals, coverage ${coverage.coverageRatio}` +
      `, weight scored ${coverage.weightScored}`,
  );
  for (const series of snapshot.series) {
    const seriesMomentum = series.momentum === null ? '' : `  momentum ${series.momentum.score}`;
    console.log(`${series.id}  index ${series.index.score ?? 'n/a'}${seriesMomentum}`);
    for (const entity of series.entities) {
      if (entity.status === 'scored') {
        console.log(
          `  ${entity.entityId.padEnd(14)} score ${String(entity.score).padStart(6)}` +
            `  level ${String(entity.level).padStart(8)}  ${series.unit} ${entity.value}`,
        );
      } else {
        console.log(`  ${entity.entityId.padEnd(14)} unscored: ${entity.reason}`);
      }
    }
  }
  console.log(`definition ${snapshot.definitionId} sha256 ${snapshot.definitionSha256}`);
  console.log(`signer ${signed.attestation.publicKey}`);
  console.log(`payload sha256 ${signed.attestation.payloadSha256}`);
}

/**
 * Finds what trended outside the basket for one day.
 *
 * Presentation only, so a failure is reported and the published epoch stands:
 * the page keeps showing measured basket trends rather than going dark.
 */
async function discover(day: string): Promise<void> {
  if (!isValidDay(day)) {
    throw new Error(`invalid --day: ${day}`);
  }
  try {
    const record = await refreshDiscoveryRecord({
      day,
      basket: ENTITY_BASKET,
      snapshotsDir: SNAPSHOTS_DIR,
    });
    console.log(`discovery ${day}: ${record.entries.length} trending topics`);
    for (const entry of record.entries) {
      console.log(
        `  ${entry.topic.padEnd(30)} ${String(entry.views).padStart(8)} views` +
          `  +${entry.momentum}% over ${entry.baselineDays}d`,
      );
    }
  } catch (error) {
    console.warn(
      `discovery skipped for ${day}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Publishes the social panel beside the index.
 *
 * This is a separate command on purpose: an epoch build must not depend on a
 * paid, authenticated API, and a missing key leaves the panel unpublished
 * rather than empty.
 */
async function social(): Promise<void> {
  const apiKey = process.env[SOCIAL_KEY_ENV];
  if (apiKey === undefined || apiKey.trim() === '') {
    console.log(`social panel not configured: set ${SOCIAL_KEY_ENV} to fetch it`);
    return;
  }
  const panel = await fetchSocialPanel({
    apiKey,
    query: socialQuery(ENTITY_BASKET),
    now: new Date(),
  });
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  await writeFile(join(SNAPSHOTS_DIR, 'social.json'), JSON.stringify(panel, null, 2));
  console.log(
    `social panel: ${panel.totals.posts} posts, ${panel.totals.likes} likes` +
      `${panel.truncated ? ', page budget reached' : ''} (display only, weight 0)`,
  );
}

/**
 * Prints whether the published index is current. Exits non-zero when it is not,
 * so a monitor can call this command without parsing anything.
 */
async function health(maxAgeDays: number): Promise<void> {
  const report = await readSnapshotHealth({ snapshotsDir: SNAPSHOTS_DIR, maxAgeDays });
  const summary =
    `health ${report.status}: ${report.detail}` +
    (report.indexScore === null ? '' : `, index ${report.indexScore}`) +
    (report.coverageRatio === null ? '' : `, coverage ${report.coverageRatio}`);
  if (report.status === 'ok') {
    console.log(summary);
    return;
  }
  console.error(summary);
  process.exitCode = 1;
}

/**
 * Rebuilds one published day and reports where it disagrees.
 *
 * A third party can run the same check against the public snapshot and the URLs
 * recorded in it, which is the point of publishing both.
 */
async function verify(day: string): Promise<void> {
  if (!isValidDay(day)) {
    throw new Error(`invalid --day: ${day}`);
  }
  const result = await verifyDay(SNAPSHOTS_DIR, day);
  const line = `verify ${result.status}: ${result.detail}`;
  if (result.status === 'verified') {
    console.log(line);
    return;
  }
  console.error(line);
  for (const difference of result.differences) {
    console.error(
      `  ${difference.scope}: published ${difference.published}, ` +
        `recomputed ${difference.recomputed}`,
    );
  }
  process.exitCode = 1;
}

/** Files of the marketing and markets app, published under /app/. */
async function appFiles(): Promise<ReadonlyArray<readonly [string, string | Uint8Array]>> {
  let names: string[];
  try {
    // The auth source ships as a bundle, so publishing it would only add a file
    // the page cannot load.
    names = (await readdir(APP_DIR))
      .filter((name) => !name.startsWith('.') && name !== AUTH_CLIENT_SOURCE)
      .sort();
  } catch {
    return [];
  }
  const files: Array<readonly [string, string | Uint8Array]> = [];
  for (const name of names) {
    files.push([`app/${name}`, await readFile(join(APP_DIR, name))]);
  }
  return files;
}

/**
 * Writes the site and every JSON route as static files.
 *
 * The page asks for the same relative paths either way, so one build serves both
 * from this server and from a plain file host. No route here does per-request
 * work, which is why the export cannot fall behind the server.
 */
async function exportStatic(outDir: string): Promise<void> {
  const files = new Map<string, string | Uint8Array>();
  const pages = (await readdir(PUBLIC_DIR)).filter((name) => name.endsWith('.html')).sort();
  if (!pages.includes('index.html')) {
    throw new Error(`missing page: ${join(PUBLIC_DIR, 'index.html')}`);
  }
  for (const name of pages) {
    files.set(name, await readFile(join(PUBLIC_DIR, name), 'utf8'));
  }
  for (const [target, body] of await appFiles()) {
    files.set(target, body);
  }
  files.set('api/basket', basketPayload(ENTITY_BASKET));
  files.set('api/markets', await marketsPayload(MARKETS_DIR));
  files.set('api/index/history', await historyPayload(SNAPSHOTS_DIR));
  files.set('api/trends', await trendsPayload({ snapshotsDir: SNAPSHOTS_DIR, basket: ENTITY_BASKET }));

  for (const day of await publishedDays()) {
    const body = await readFile(join(SNAPSHOTS_DIR, `${day}.json`), 'utf8');
    files.set(`api/index/snapshot/${day}`, body);
  }
  const optional: ReadonlyArray<readonly [string, string]> = [
    ['api/index/latest', 'latest.json'],
    ['api/social/latest', 'social.json'],
  ];
  for (const [target, name] of optional) {
    try {
      files.set(target, await readFile(join(SNAPSHOTS_DIR, name), 'utf8'));
    } catch {
      continue;
    }
  }

  for (const [path, body] of files) {
    const target = join(outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  console.log(`exported ${files.size} files to ${outDir}`);
}

async function serve(port: number, maxAgeDays: number): Promise<void> {
  const server = await startServer({
    port,
    publicDir: PUBLIC_DIR,
    snapshotsDir: SNAPSHOTS_DIR,
    basket: ENTITY_BASKET,
    marketsDir: MARKETS_DIR,
    appDir: APP_DIR,
    maxAgeDays,
  });
  console.log(`serving on http://127.0.0.1:${port}`);
  await new Promise<void>((resolveStop) => {
    const stop = () => {
      server.close(() => resolveStop());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * Publishes the requested day, or the trailing window when `--catch-up` is set,
 * then refreshes discovery for the newest day it published.
 */
async function runBuild(values: Record<string, string | boolean | undefined>): Promise<void> {
  const targetDay = typeof values.day === 'string' ? values.day : addDays(toDay(new Date()), -1);
  const force = values.force === true;
  const catchUp = values['catch-up'] === undefined ? 0 : Number(values['catch-up']);
  const days =
    catchUp === 0
      ? [targetDay]
      : missingEpochDays({ publishedDays: await publishedDays(), targetDay, limit: catchUp });
  if (days.length === 0) {
    console.log(`nothing to build: every day up to ${targetDay} is published`);
    return;
  }
  if (days.length > 1) {
    console.log(`catch-up: publishing ${days.length} days, ${days[0]} to ${days.at(-1)}`);
  }
  const definitionId =
    typeof values.definition === 'string' ? values.definition : ACTIVE_DEFINITION_ID;
  for (const day of days) {
    await build(day, force, definitionId);
  }
  const newest = days.at(-1);
  if (newest !== undefined) {
    await discover(newest);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      day: { type: 'string' },
      'base-day': { type: 'string' },
      definition: { type: 'string' },
      id: { type: 'string' },
      days: { type: 'string' },
      port: { type: 'string' },
      'catch-up': { type: 'string' },
      'max-age-days': { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];

  if (values.help || command === undefined) {
    console.log(USAGE);
    return;
  }
  if (command === 'build') {
    await runBuild(values);
    return;
  }
  if (command === 'calibrate') {
    const id = values.id ?? ACTIVE_DEFINITION_ID;
    const baseDay = values['base-day'] ?? addDays(toDay(new Date()), -1);
    const days = values.days === undefined ? CALIBRATION_DAYS : Number(values.days);
    if (!Number.isInteger(days) || days < 1) {
      throw new Error(`invalid --days: ${values.days}`);
    }
    await calibrate(id, baseDay, days);
    return;
  }
  if (command === 'discover') {
    await discover(values.day ?? (await publishedDays()).at(-1) ?? addDays(toDay(new Date()), -1));
    return;
  }
  // Both commands serve the app files, so the auth bundle has to exist first.
  if (command === 'export' || command === 'serve') {
    await buildAuthClient(APP_DIR, REPO_ROOT);
  }
  if (command === 'export') {
    const outDir = values.out;
    if (typeof outDir !== 'string' || outDir.trim() === '') {
      throw new Error('--out DIR is required');
    }
    await exportStatic(resolve(outDir));
    return;
  }
  if (command === 'health') {
    const maxAgeDays =
      values['max-age-days'] === undefined ? DEFAULT_MAX_AGE_DAYS : Number(values['max-age-days']);
    await health(maxAgeDays);
    return;
  }
  if (command === 'social') {
    await social();
    return;
  }
  if (command === 'verify') {
    const day =
      typeof values.day === 'string'
        ? values.day
        : (await publishedDays()).at(-1) ?? addDays(toDay(new Date()), -1);
    await verify(day);
    return;
  }
  if (command === 'serve') {
    const maxAgeDays =
      values['max-age-days'] === undefined ? DEFAULT_MAX_AGE_DAYS : Number(values['max-age-days']);
    await serve(Number(values.port ?? 8080), maxAgeDays);
    return;
  }
  throw new Error(`unknown command: ${command}\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
