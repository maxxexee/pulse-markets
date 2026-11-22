import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  loadOrCreateSigner,
  loadSignerIfPresent,
  signSnapshot,
  verifySignedSnapshot,
} from './adapters/attestation.ts';
import { buildAuthClient } from './app/auth-bundle.ts';
import { buildSnapshot } from './app/build-snapshot.ts';
import { calibrate } from './app/calibrate.ts';
import {
  latestDiscoveryDay,
  readDiscovery,
  refreshDiscovery as refreshDiscoveryRecord,
} from './app/discovery.ts';
import { exportStatic } from './app/export-site.ts';
import { verifyChain, verifyTrends } from './app/report-commands.ts';
import { startServer } from './app/server.ts';
import { verifyDay } from './app/verify.ts';
import { fetchSocialPanel, fetchSocialTopics, SOCIAL_KEY_ENV } from './adapters/twitter.ts';
import { fetchBlueskyTopics } from './adapters/bluesky.ts';
import { DEFAULT_MAX_AGE_DAYS, readSnapshotHealth } from './adapters/health.ts';
import { publishTrendEpoch, verifyTrendChain, verifyTrendEpoch } from './app/trend-epoch.ts';
import { ENTITY_BASKET } from './config/entities.ts';
import { ACTIVE_DEFINITION_ID, CALIBRATION_DAYS } from './config/index-definition.ts';
import { socialQuery, socialTopicQueries } from './config/social.ts';
import type { IndexDefinition } from '@pulse/index-core/index-definition.ts';
import { MIN_PUBLISH_CONFIDENCE } from '@pulse/index-core/coverage.ts';
import { addDays, isValidDay, toDay } from '@pulse/index-core/dates.ts';
import { MOMENTUM_WINDOW_DAYS } from '@pulse/index-core/momentum.ts';
import { SOCIAL_PANEL_SCHEMA, summarizeTopic } from '@pulse/index-core/social.ts';
import type { SocialPanel, SocialPost, SocialTopicPanel } from '@pulse/index-core/social.ts';
import { DISCOVERY_V1 } from '@pulse/index-core/discovery.ts';
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
  verify-trends [--day YYYY-MM-DD]
                             check a signed trend epoch's signature and terms
  verify-chain              check that every published trend epoch commits to
                             its predecessor, and list the chain

Days are UTC. build defaults to the previous UTC day. A day that is already
published is left alone unless --force is given, so a rerun never replaces a
signed epoch. --catch-up N publishes every day in the trailing N-day window that
has no snapshot yet, which is what a scheduled run uses after a skipped day.
social reads its key from ${SOCIAL_KEY_ENV} and never affects the index.`;

/** Reads a JSON file, or null when it is absent or unreadable. */
async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The newest published day, or yesterday when nothing is published yet. */
async function defaultDay(): Promise<string> {
  return (await publishedDays()).at(-1) ?? addDays(toDay(new Date()), -1);
}

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
      log: (line) => console.log(line),
    });
    console.log(`discovery ${day}: ${record.entries.length} trending topics`);
    for (const entry of record.entries) {
      console.log(
        `  ${entry.topic.padEnd(30)} ${String(entry.views).padStart(8)} views` +
          `  +${entry.momentum}% over ${entry.baselineDays}d` +
          (entry.via === 'x' ? '  [X]' : ''),
      );
    }
    const signer = loadSignerIfPresent(KEY_PATH);
    if (signer === null) {
      console.log(`trend epoch not signed: no key at ${KEY_PATH}`);
      return;
    }
    // The index epoch is already published at this point. A signing problem here
    // must not fail the whole build, or the job would retry a day it cannot
    // publish again and leave the trend epoch missing anyway.
    try {
      const signed = await publishTrendEpoch({
        record,
        snapshotsDir: SNAPSHOTS_DIR,
        signer,
        now: new Date(),
      });
      console.log(`signed trend epoch by ${signed.attestation.publicKey}`);
      console.log(`trend payload sha256 ${signed.attestation.payloadSha256}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.log(`trend epoch not signed: ${detail}`);
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
  const now = new Date();
  const day = await latestDiscoveryDay(SNAPSHOTS_DIR);
  const record = day === null ? null : await readDiscovery(SNAPSHOTS_DIR, day);
  const specs = socialTopicQueries(
    ENTITY_BASKET,
    (record?.entries ?? []).map((entry) => entry.topic),
  );

  // Bluesky first, because it is free and keyless: whatever the paid vendor is
  // doing, the pages get posts. A page is merged below rather than replaced.
  const bluesky = await fetchBlueskyTopics(specs, {
    now,
    log: (line) => console.log(line),
  });

  const apiKey = process.env[SOCIAL_KEY_ENV];
  const configured = apiKey !== undefined && apiKey.trim() !== '';
  const previous = await readJsonFile<{ posts?: readonly SocialPost[]; totals?: SocialPanel['totals'] }>(
    join(SNAPSHOTS_DIR, 'social.json'),
  );
  if (!configured) {
    console.log(`social panel not configured: set ${SOCIAL_KEY_ENV} to fetch it`);
  }

  // A vendor outage keeps the last published list rather than blanking the
  // site-wide panel, and never stops the per-page panels being written.
  let combined: { posts: readonly SocialPost[]; totals: SocialPanel['totals']; query: string; truncated: boolean } | null =
    null;
  let xTopics: Record<string, SocialTopicPanel> = {};
  if (configured) {
    try {
      const panel = await fetchSocialPanel({
        apiKey: apiKey as string,
        query: socialQuery(ENTITY_BASKET),
        now,
      });
      combined = {
        posts: panel.posts,
        totals: panel.totals,
        query: panel.query,
        truncated: panel.truncated,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.log(`social panel kept as published: ${detail}`);
    }
    try {
      xTopics = await fetchSocialTopics({
        apiKey: apiKey as string,
        topics: specs,
        now,
        log: (line) => console.log(line),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.log(`social topics not read from X: ${detail}`);
    }
  }

  // One list per page: both networks, most liked first. Two lines are shown, so
  // the ranking is what decides which posts a reader sees.
  const topics: Record<string, SocialTopicPanel> = {};
  for (const spec of specs) {
    const posts = [...(xTopics[spec.key]?.posts ?? []), ...(bluesky[spec.key]?.posts ?? [])].sort(
      (a, b) => b.likes - a.likes,
    );
    if (posts.length === 0) continue;
    topics[spec.key] = summarizeTopic({ label: spec.label, query: spec.query, posts });
  }

  if (Object.keys(topics).length === 0 && combined === null) {
    console.log('social panel left as published: no source returned posts');
    return;
  }

  const posts = combined?.posts ?? previous?.posts ?? [];
  const totals =
    combined?.totals ??
    previous?.totals ?? {
      posts: 0,
      likes: 0,
      views: 0,
    };
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  await writeFile(
    join(SNAPSHOTS_DIR, 'social.json'),
    JSON.stringify(
      {
        schema: SOCIAL_PANEL_SCHEMA,
        fetchedAt: now.toISOString(),
        query: combined?.query ?? socialQuery(ENTITY_BASKET),
        settlementWeight: 0,
        posts,
        totals,
        truncated: combined?.truncated ?? false,
        topics,
      },
      null,
      2,
    ),
  );
  const fromX = Object.values(xTopics).filter((topic) => topic.posts.length > 0).length;
  const fromBluesky = Object.values(bluesky).filter((topic) => topic.posts.length > 0).length;
  console.log(
    `social panel: ${totals.posts} posts, ${totals.likes} likes` +
      `${combined?.truncated ? ', page budget reached' : ''} (display only, weight 0)`,
  );
  console.log(
    `social topics: ${Object.keys(topics).length}/${specs.length} pages` +
      ` (x ${fromX}, bluesky ${fromBluesky})` +
      (day === null ? '' : ` (board ${day})`),
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

async function serve(port: number, maxAgeDays: number): Promise<void> {
  const server = await startServer({
    port,
    publicDir: PUBLIC_DIR,
    snapshotsDir: SNAPSHOTS_DIR,
    basket: ENTITY_BASKET,
    marketsDir: MARKETS_DIR,
    appDir: APP_DIR,
    docsDir: join(REPO_ROOT, 'docs'),
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

/** Writes the site and every JSON route as plain files under `outDir`. */
async function exportCommand(out: string | boolean | undefined): Promise<void> {
  if (typeof out !== 'string' || out.trim() === '') {
    throw new Error('--out DIR is required');
  }
  const written = await exportStatic({
    outDir: resolve(out),
    publicDir: PUBLIC_DIR,
    appDir: APP_DIR,
    snapshotsDir: SNAPSHOTS_DIR,
    marketsDir: MARKETS_DIR,
    docsDir: join(REPO_ROOT, 'docs'),
    basket: ENTITY_BASKET,
  });
  console.log(`exported ${written} files to ${resolve(out)}`);
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
    await discover(typeof values.day === 'string' ? values.day : await defaultDay());
    return;
  }
  // Both commands serve the app files, so the auth bundle has to exist first.
  if (command === 'export' || command === 'serve') {
    await buildAuthClient(APP_DIR, REPO_ROOT);
  }
  if (command === 'export') {
    await exportCommand(values.out);
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
    await verify(typeof values.day === 'string' ? values.day : await defaultDay());
    return;
  }
  if (command === 'verify-trends') {
    await verifyTrends(SNAPSHOTS_DIR, values.day);
    return;
  }
  if (command === 'verify-chain') {
    await verifyChain(SNAPSHOTS_DIR);
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
