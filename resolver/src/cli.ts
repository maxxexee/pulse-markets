import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { INDEX_DEFINITION_ID } from '../../index-service/src/config/index-definition.ts';
import {
  createMarketSpec,
  DEFAULT_MIN_CONFIDENCE,
  MarketError,
  type MarketDefinition,
  type MarketSpec,
} from './domain/market.ts';
import { resolveMarket } from './domain/resolution.ts';
import { readSignedSnapshot, SnapshotReadError } from './adapters/snapshot.ts';

const USAGE = `Usage:
  node src/cli.ts create --threshold 55 --comparison above --day 2026-11-20 --signer <base58>
  node src/cli.ts resolve --spec market.json --snapshot snapshots/2026-11-20.json [--now ISO] [--out resolution.json]

create prints the full market spec, including the id derived from its terms.
resolve prints the settlement record. Both exit 1 on a rejected input.`;

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function marketFrom(values: Record<string, string | boolean | undefined>): MarketSpec {
  const definition: MarketDefinition = {
    definitionId: required(values, 'definition'),
    signer: required(values, 'signer'),
    threshold: Number(required(values, 'threshold')),
    comparison: required(values, 'comparison') as MarketDefinition['comparison'],
    epochDay: required(values, 'day'),
    minConfidence: Number(values['min-confidence'] ?? DEFAULT_MIN_CONFIDENCE),
    createdAt: required(values, 'created-at'),
  };
  return createMarketSpec(definition);
}

async function create(values: Record<string, string | boolean | undefined>): Promise<void> {
  const spec = marketFrom(values);
  process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
}

/** Rebuilds the spec from its own fields so stray keys cannot change the id. */
function specFromFile(raw: Partial<MarketSpec>): MarketSpec {
  const spec = createMarketSpec({
    definitionId: raw.definitionId as string,
    signer: raw.signer as string,
    threshold: raw.threshold as number,
    comparison: raw.comparison as MarketDefinition['comparison'],
    epochDay: raw.epochDay as string,
    minConfidence: raw.minConfidence as number,
    createdAt: raw.createdAt as string,
  });
  if (spec.id !== raw.id) {
    throw new MarketError('invalid-definition', 'market id does not match its terms');
  }
  return spec;
}

async function resolve(values: Record<string, string | boolean | undefined>): Promise<void> {
  const specPath = required(values, 'spec');
  const snapshotPath = required(values, 'snapshot');
  const raw = JSON.parse(await readFile(specPath, 'utf8')) as Partial<MarketSpec>;
  const spec = specFromFile(raw);
  const signed = await readSignedSnapshot(snapshotPath);
  const nowValue = values['now'];
  const now = typeof nowValue === 'string' ? new Date(nowValue) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`--now is not a timestamp: ${String(nowValue)}`);
  }
  const result = resolveMarket(spec, signed, now);
  if (!result.ok) {
    process.stderr.write(`not settled: ${result.error.kind}: ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const body = `${JSON.stringify(result.resolution, null, 2)}\n`;
  const out = values.out;
  if (typeof out === 'string') {
    await writeFile(out, body, 'utf8');
  }
  process.stdout.write(body);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const rest = process.argv.slice(3);
  if (command === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        definition: { type: 'string', default: INDEX_DEFINITION_ID },
        signer: { type: 'string' },
        threshold: { type: 'string' },
        comparison: { type: 'string' },
        day: { type: 'string' },
        'min-confidence': { type: 'string' },
        'created-at': { type: 'string', default: new Date().toISOString() },
      },
      allowPositionals: false,
    });
    await create(values);
    return;
  }
  if (command === 'resolve') {
    const { values } = parseArgs({
      args: rest,
      options: {
        spec: { type: 'string' },
        snapshot: { type: 'string' },
        now: { type: 'string' },
        out: { type: 'string' },
      },
      allowPositionals: false,
    });
    await resolve(values);
    return;
  }
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  if (error instanceof MarketError || error instanceof SnapshotReadError) {
    process.stderr.write(`${error.kind}: ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
