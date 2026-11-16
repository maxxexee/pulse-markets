import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadOrCreateSigner, signSnapshot, verifySignedSnapshot } from './adapters/attestation.ts';
import { buildSnapshot } from './app/build-snapshot.ts';
import { startServer } from './app/server.ts';
import { fetchSocialPanel, SOCIAL_KEY_ENV } from './adapters/twitter.ts';
import { ENTITY_BASKET } from './config/entities.ts';
import { socialQuery } from './config/social.ts';
import { addDays, isValidDay, toDay } from './domain/dates.ts';
import { MOMENTUM_WINDOW_DAYS } from './domain/momentum.ts';
import type { IndexSnapshot } from './domain/snapshot.ts';

const SERVICE_ROOT = resolve(import.meta.dirname, '..');
const SNAPSHOTS_DIR = join(SERVICE_ROOT, 'snapshots');
const KEY_PATH = join(SERVICE_ROOT, '.keys', 'index-signer.pem');
const PUBLIC_DIR = join(SERVICE_ROOT, 'public');

const USAGE = `pulse index-service

  build [--day YYYY-MM-DD]   compute, sign and publish an epoch snapshot
  social                     fetch the display-only social panel, if configured
  serve [--port N]           serve the public index and the latest snapshot

Days are UTC. build defaults to the previous UTC day. social reads its key from
${SOCIAL_KEY_ENV} and never affects the index.`;

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

async function build(day: string): Promise<void> {
  if (!isValidDay(day)) {
    throw new Error(`invalid --day: ${day}`);
  }

  const reference = await loadReference(addDays(day, -MOMENTUM_WINDOW_DAYS));
  const snapshot = await buildSnapshot({
    entities: ENTITY_BASKET,
    targetDay: day,
    now: new Date(),
    history: reference === null ? [] : [reference],
  });

  const signed = signSnapshot(snapshot, loadOrCreateSigner(KEY_PATH));
  if (!verifySignedSnapshot(signed)) {
    throw new Error('signature self-check failed, refusing to publish');
  }

  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const body = JSON.stringify(signed, null, 2);
  await writeFile(join(SNAPSHOTS_DIR, `${day}.json`), body);
  await writeFile(join(SNAPSHOTS_DIR, 'latest.json'), body);

  console.log(`epoch ${day}  index ${snapshot.index.score ?? 'n/a'}`);
  const momentum = snapshot.momentum;
  console.log(
    momentum === null
      ? `momentum n/a (no snapshot for ${addDays(day, -MOMENTUM_WINDOW_DAYS)})`
      : `momentum ${momentum.score} (${momentum.delta >= 0 ? '+' : ''}${momentum.delta} points over ${momentum.windowDays}d)`,
  );
  const coverage = snapshot.coverage;
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
    options: { day: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } },
  });
  const command = positionals[0];

  if (values.help || command === undefined) {
    console.log(USAGE);
    return;
  }
  if (command === 'build') {
    await build(values.day ?? addDays(toDay(new Date()), -1));
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
