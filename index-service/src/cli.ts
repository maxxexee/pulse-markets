import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadOrCreateSigner, signSnapshot, verifySignedSnapshot } from './adapters/attestation.ts';
import { buildSnapshot } from './app/build-snapshot.ts';
import { startServer } from './app/server.ts';
import { fetchSocialPanel, SOCIAL_KEY_ENV } from './adapters/twitter.ts';
import { ENTITY_BASKET } from './config/entities.ts';
import { socialQuery } from './config/social.ts';
import { MIN_PUBLISH_CONFIDENCE } from './domain/coverage.ts';
import { addDays, isValidDay, toDay } from './domain/dates.ts';
import { MOMENTUM_WINDOW_DAYS } from './domain/momentum.ts';
import { missingEpochDays } from './domain/schedule.ts';
import type { IndexSnapshot } from './domain/snapshot.ts';

const SERVICE_ROOT = resolve(import.meta.dirname, '..');
const SNAPSHOTS_DIR = join(SERVICE_ROOT, 'snapshots');
const KEY_PATH = join(SERVICE_ROOT, '.keys', 'index-signer.pem');
const PUBLIC_DIR = join(SERVICE_ROOT, 'public');

const USAGE = `pulse index-service

  build [--day YYYY-MM-DD] [--catch-up N] [--force]
                             compute, sign and publish an epoch snapshot
  social                     fetch the display-only social panel, if configured
  serve [--port N]           serve the public index and the latest snapshot

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

async function build(day: string, force: boolean): Promise<void> {
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
  const snapshot = await buildSnapshot({
    entities: ENTITY_BASKET,
    targetDay: day,
    now: new Date(),
    history: reference === null ? [] : [reference],
  });

  const coverage = snapshot.coverage;
  if (coverage.confidence < MIN_PUBLISH_CONFIDENCE) {
    throw new Error(
      `refusing to publish ${day}: coverage ${coverage.confidence} is below the ` +
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
      ? `momentum n/a (no snapshot for ${addDays(day, -MOMENTUM_WINDOW_DAYS)})`
      : `momentum ${momentum.score} (${momentum.delta >= 0 ? '+' : ''}${momentum.delta} points over ${momentum.windowDays}d)`,
  );
  console.log(
    `coverage ${coverage.seriesScored}/${coverage.seriesExpected} series` +
      `, ${coverage.signalsScored}/${coverage.signalsTotal} signals, confidence ${coverage.confidence}`,
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
  console.log(`signer ${signed.attestation.publicKey}`);
  console.log(`payload sha256 ${signed.attestation.payloadSha256}`);
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

async function serve(port: number): Promise<void> {
  const server = await startServer({
    port,
    publicDir: PUBLIC_DIR,
    snapshotsDir: SNAPSHOTS_DIR,
    basket: ENTITY_BASKET,
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

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      day: { type: 'string' },
      port: { type: 'string' },
      'catch-up': { type: 'string' },
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
    const targetDay = values.day ?? addDays(toDay(new Date()), -1);
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
    for (const day of days) {
      await build(day, force);
    }
    return;
  }
  if (command === 'social') {
    await social();
    return;
  }
  if (command === 'serve') {
    await serve(Number(values.port ?? 8080));
    return;
  }
  throw new Error(`unknown command: ${command}\n\n${USAGE}`);

}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
