import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { MarketSpec } from '../domain/market.ts';
import type { TrendMarketSpec } from '../domain/trend-market.ts';

/** Terms pm-AMM needs to name a market, whichever rule settles it. */
type ChainMarketSpec = MarketSpec | TrendMarketSpec;
import type { ResolutionOutcome } from '../domain/resolution.ts';

const require = createRequire(import.meta.url);

/** Both clusters deploy the same program; only the collateral mint differs. */
const DEFAULT_PROGRAM_ID = 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y';
const DEFAULT_DEVNET_USDC = '3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
/**
 * Shortest market the deployed pm-AMM program accepts.
 *
 * The SDK documents five minutes, but the devnet program rejects a 300 second
 * market with InvalidDuration (6012) and accepts 3600, so the floor enforced
 * here is the one the chain actually applies. A shorter market is refused before
 * it costs a simulation round trip.
 */
const MIN_DURATION_SECS = 3600;
const MAX_NAME_BYTES = 64;

export type ChainErrorKind = 'chain-config' | 'chain-input' | 'chain-send';

export class ChainError extends Error {
  readonly kind: ChainErrorKind;

  constructor(kind: ChainErrorKind, message: string) {
    super(message);
    this.name = 'ChainError';
    this.kind = kind;
  }
}

export interface ChainConfig {
  readonly rpcUrl: string;
  readonly keypairPath: string;
  readonly programId: string;
  readonly collateralMint: string;
}

/** Reads chain settings from the environment, which is where a key path belongs. */
export function chainConfigFromEnv(env: NodeJS.ProcessEnv): ChainConfig {
  const keypairPath = env.PULSE_KEYPAIR;
  if (keypairPath === undefined || keypairPath.length === 0) {
    throw new ChainError('chain-config', 'PULSE_KEYPAIR must name a keypair file');
  }
  return {
    rpcUrl: env.PULSE_RPC_URL ?? DEFAULT_RPC_URL,
    keypairPath,
    programId: env.PULSE_PM_AMM_PROGRAM ?? DEFAULT_PROGRAM_ID,
    collateralMint: env.PULSE_USDC_MINT ?? DEFAULT_DEVNET_USDC,
  };
}

/** The market question, cut on a byte boundary so the name stays valid UTF-8. */
export function marketName(spec: ChainMarketSpec): string {
  const side = spec.comparison === 'below' ? 'below' : 'above';
  const subject = 'kind' in spec ? 'trend momentum' : 'attention close';
  const name = `PULSE ${subject} ${side} ${spec.threshold} on ${spec.epochDay}?`;
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length <= MAX_NAME_BYTES) {
    return name;
  }
  return bytes.subarray(0, MAX_NAME_BYTES).toString('utf8').replace(/\uFFFD$/u, '').trimEnd();
}

/** Epoch end as a unix timestamp, the value pm-AMM closes the market on. */
export function epochEndTs(epochDay: string): number {
  return Math.floor(Date.parse(`${epochDay}T00:00:00Z`) / 1000);
}

export interface CreateOnChainOptions {
  /** Seconds the market trades before expiry; at least 3600. */
  readonly durationSecs: number;
  /** Starting YES price in basis points of probability, 100 to 9900. */
  readonly initialPriceBps: number;
  /** Collateral seeded as liquidity, in whole USDC; zero opens an empty book. */
  readonly depositUsdc: number;
}

export interface OnChainMarket {
  readonly marketId: number;
  readonly marketPda: string;
  readonly signature: string;
}

interface PmAmmSend {
  createMarket(input: {
    name: string;
    durationSecs: number;
    initialPriceBps: number;
    depositUsdc: number;
  }): Promise<OnChainMarket>;
  resolveMarket(market: unknown, side: ResolutionOutcome): Promise<string>;
}

interface PmAmmClientLike {
  readonly send: PmAmmSend;
}

interface PmAmmSdk {
  PmAmmClient: {
    fromProvider(provider: unknown, programId: unknown, collateralMint: unknown): PmAmmClientLike;
  };
}

interface AnchorCore {
  AnchorProvider: new (connection: unknown, wallet: unknown, opts: unknown) => unknown;
  Wallet: new (keypair: unknown) => unknown;
}

interface Web3 {
  Connection: new (endpoint: string, commitment?: string) => unknown;
  Keypair: { fromSecretKey(secret: Uint8Array): unknown };
  PublicKey: new (value: string) => unknown;
}

async function loadClient(config: ChainConfig): Promise<PmAmmClientLike> {
  const sdk = require('@pm-amm/sdk') as PmAmmSdk;
  const anchor = require('@anchor-lang/core') as AnchorCore;
  const web3 = require('@solana/web3.js') as Web3;

  let secret: number[];
  try {
    secret = JSON.parse(await readFile(config.keypairPath, 'utf8')) as number[];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ChainError('chain-config', `cannot read keypair: ${detail}`);
  }
  let keypair: unknown;
  try {
    keypair = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ChainError('chain-config', `keypair file is not a secret key: ${detail}`);
  }
  const connection = new web3.Connection(config.rpcUrl, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {
    commitment: 'confirmed',
  });
  return sdk.PmAmmClient.fromProvider(
    provider,
    new web3.PublicKey(config.programId),
    new web3.PublicKey(config.collateralMint),
  );
}

function sendFailure(action: string, error: unknown): ChainError {
  const detail = error instanceof Error ? error.message : String(error);
  return new ChainError('chain-send', `${action} failed: ${detail}`);
}

/**
 * Opens a pm-AMM binary market for a published spec.
 *
 * The chain takes a name and a duration, not the spec: the signed terms stay in
 * the market file, and its id is what identifies the market off chain. This
 * only makes the question tradeable.
 */
export async function createOnChain(
  config: ChainConfig,
  spec: ChainMarketSpec,
  options: CreateOnChainOptions,
): Promise<OnChainMarket> {
  if (!Number.isInteger(options.durationSecs) || options.durationSecs < MIN_DURATION_SECS) {
    throw new ChainError(
      'chain-input',
      `duration must be an integer of at least ${MIN_DURATION_SECS} seconds`,
    );
  }
  if (!Number.isInteger(options.initialPriceBps) ||
    options.initialPriceBps < 100 ||
    options.initialPriceBps > 9900) {
    throw new ChainError('chain-input', 'initial price must be 100 to 9900 basis points');
  }
  const client = await loadClient(config);
  try {
    return await client.send.createMarket({
      name: marketName(spec),
      durationSecs: options.durationSecs,
      initialPriceBps: options.initialPriceBps,
      depositUsdc: options.depositUsdc,
    });
  } catch (error) {
    throw sendFailure('createMarket', error);
  }
}

/**
 * Resolves an existing pm-AMM market to the settlement's outcome.
 *
 * The outcome is decided off the signed snapshot; this only carries it to the
 * chain. The signer must be the market authority, because pm-AMM has no oracle:
 * resolution is an admin action, which is exactly the trust this design makes
 * explicit.
 */
export async function resolveOnChain(
  config: ChainConfig,
  market: string,
  outcome: ResolutionOutcome,
): Promise<string> {
  if (market.length === 0) {
    throw new ChainError('chain-input', 'market address is empty');
  }
  const client = await loadClient(config);
  try {
    return await client.send.resolveMarket(market, outcome);
  } catch (error) {
    throw sendFailure('resolveMarket', error);
  }
}
