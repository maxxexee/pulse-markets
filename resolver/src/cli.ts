import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ACTIVE_DEFINITION_ID } from '../../index-service/src/config/index-definition.ts';
import {
  createMarketSpec,
  DEFAULT_MIN_CONFIDENCE,
  MarketError,
  type MarketDefinition,
  type MarketSpec,
} from './domain/market.ts';
import { resolveMarket } from './domain/resolution.ts';
import { readSignedSnapshot, SnapshotReadError } from './adapters/snapshot.ts';
import {
  ChainError,
  chainConfigFromEnv,
  createOnChain,
  resolveOnChain,
} from './adapters/pm-amm.ts';

const USAGE = `Usage:
  node src/cli.ts create --threshold 55 --comparison above --day 2026-11-20 --signer <base58>
  node src/cli.ts resolve --spec market.json --snapshot snapshots/2026-11-20.json [--now ISO] [--out resolution.json]

create prints the full market spec, including the id derived from its terms.
resolve prints the settlement record. Both exit 1 on a rejected input.

Add --on-chain to also act on the pm-AMM program. create takes
--duration-secs, --initial-price-bps and --deposit-usdc; resolve takes the
market address with --market. Chain settings come from PULSE_KEYPAIR (required),
PULSE_RPC_URL, PULSE_PM_AMM_PROGRAM and PULSE_USDC_MINT.`;

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

/** Flag that may be absent, so older market files keep rebuilding the same id. */
function optional(
  values: Record<string, string | boolean | undefined>,
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Spreads the pinned hash only when it is present, since the field is optional. */
function pinnedFrom(hash: string | undefined): { definitionSha256?: string } {
  return hash === undefined ? {} : { definitionSha256: hash };
}

function marketFrom(values: Record<string, string | boolean | undefined>): MarketSpec {
  const definition: MarketDefinition = {
    definitionId: required(values, 'definition'),
    ...pinnedFrom(optional(values, 'definition-sha256')),
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
  if (values['on-chain'] !== true) {
    return;
  }
  const market = await createOnChain(chainConfigFromEnv(process.env), spec, {
    durationSecs: Number(values['duration-secs'] ?? 86_400),
    initialPriceBps: Number(values['initial-price-bps'] ?? 5000),
    depositUsdc: Number(values['deposit-usdc'] ?? 0),
  });
  process.stderr.write(
    `on-chain market ${market.marketPda} (id ${market.marketId}) signature ${market.signature}\n`,
  );
}

/** Rebuilds the spec from its own fields so stray keys cannot change the id. */
function specFromFile(raw: Partial<MarketSpec>): MarketSpec {
  const spec = createMarketSpec({
    definitionId: raw.definitionId as string,
    ...pinnedFrom(raw.definitionSha256),
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
  if (values['on-chain'] === true) {
    const market = required(values, 'market');
    const signature = await resolveOnChain(
      chainConfigFromEnv(process.env),
      market,
      result.resolution.outcome,
    );
    process.stderr.write(`on-chain resolved ${result.resolution.outcome} signature ${signature}\n`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const rest = process.argv.slice(3);
  if (command === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        definition: { type: 'string', default: ACTIVE_DEFINITION_ID },
        'definition-sha256': { type: 'string' },
        signer: { type: 'string' },
        threshold: { type: 'string' },
        comparison: { type: 'string' },
        day: { type: 'string' },
        'min-confidence': { type: 'string' },
        'created-at': { type: 'string', default: new Date().toISOString() },
        'on-chain': { type: 'boolean', default: false },
        'duration-secs': { type: 'string' },
        'initial-price-bps': { type: 'string' },
        'deposit-usdc': { type: 'string' },
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
        'on-chain': { type: 'boolean', default: false },
        market: { type: 'string' },
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
  if (error instanceof MarketError || error instanceof SnapshotReadError || error instanceof ChainError) {
    process.stderr.write(`${error.kind}: ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
