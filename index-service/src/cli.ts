import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadOrCreateSigner, signSnapshot, verifySignedSnapshot } from './adapters/attestation.ts';
import { fetchPageviews } from './adapters/wikipedia-pageviews.ts';
import { buildSnapshot } from './app/build-snapshot.ts';
import { startServer } from './app/server.ts';
import { ENTITY_BASKET } from './config/entities.ts';
import { addDays, isValidDay, toDay } from './domain/dates.ts';

const SERVICE_ROOT = resolve(import.meta.dirname, '..');
const SNAPSHOTS_DIR = join(SERVICE_ROOT, 'snapshots');
const KEY_PATH = join(SERVICE_ROOT, '.keys', 'index-signer.pem');
const PUBLIC_DIR = join(SERVICE_ROOT, 'public');

const USAGE = `pulse index-service

  build [--day YYYY-MM-DD]   compute, sign and publish an epoch snapshot
  serve [--port N]           serve the public index and the latest snapshot

Days are UTC. build defaults to the previous UTC day.`;

async function build(day: string): Promise<void> {
  if (!isValidDay(day)) {
    throw new Error(`invalid --day: ${day}`);
  }

  const snapshot = await buildSnapshot({
    entities: ENTITY_BASKET,
    targetDay: day,
    now: new Date(),
    fetchEntity: (entity, startDay, endDay) =>
      fetchPageviews(entity.wikipediaArticle, startDay, endDay),
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
  console.log(`scored ${snapshot.index.scoredEntities}/${snapshot.index.totalEntities} entities`);
  for (const entity of snapshot.entities) {
    if (entity.status === 'scored') {
      console.log(
        `  ${entity.entityId.padEnd(14)} score ${String(entity.score).padStart(6)}` +
          `  level ${String(entity.level).padStart(8)}  views ${entity.views}`,
      );
    } else {
      console.log(`  ${entity.entityId.padEnd(14)} unscored: ${entity.reason}`);
    }
  }
  console.log(`signer ${signed.attestation.publicKey}`);
  console.log(`payload sha256 ${signed.attestation.payloadSha256}`);
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
