import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketSpec } from '../src/domain/market.ts';
import {
  ChainError,
  chainConfigFromEnv,
  createOnChain,
  epochEndTs,
  marketName,
  resolveOnChain,
} from '../src/adapters/pm-amm.ts';

const SPEC = createMarketSpec({
  definitionId: 'pulse-attention-v5',
  definitionSha256: 'dc5f963764abaae60db02ed20d48bcd6c3a1cda3f2303ffd9566ba5ddc16074c',
  signer: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  threshold: 65,
  comparison: 'above',
  epochDay: '2026-11-20',
  minConfidence: 0.5,
  createdAt: '2026-11-18T00:00:00.000Z',
});

const CONFIG = {
  rpcUrl: 'http://127.0.0.1:9',
  keypairPath: '/nonexistent/keypair.json',
  programId: 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y',
  collateralMint: '3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ',
};

test('refuses chain use without a keypair path', () => {
  assert.throws(() => chainConfigFromEnv({}), (error: unknown) => {
    assert.ok(error instanceof ChainError);
    assert.equal(error.kind, 'chain-config');
    return true;
  });
});

test('defaults the program and devnet collateral, keeps the given rpc', () => {
  const config = chainConfigFromEnv({ PULSE_KEYPAIR: '/tmp/k.json', PULSE_RPC_URL: 'https://rpc.test' });
  assert.equal(config.keypairPath, '/tmp/k.json');
  assert.equal(config.rpcUrl, 'https://rpc.test');
  assert.equal(config.collateralMint, '3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ');
  assert.equal(config.programId, 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y');
});

test('market name fits the program limit and states the terms', () => {
  const name = marketName(SPEC);
  assert.ok(Buffer.byteLength(name, 'utf8') <= 64);
  assert.match(name, /above 65/);
  assert.match(name, /2026-11-20/);
});

test('epoch end is midnight UTC of the settlement day', () => {
  assert.equal(epochEndTs('2026-11-20'), 1795132800);
});

test('rejects a duration the program will not accept before touching the chain', async () => {
  await assert.rejects(
    createOnChain(CONFIG, SPEC, { durationSecs: 120, initialPriceBps: 5000, depositUsdc: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof ChainError);
      assert.equal(error.kind, 'chain-input');
      return true;
    },
  );
});

test('rejects an out of range opening price', async () => {
  await assert.rejects(
    createOnChain(CONFIG, SPEC, { durationSecs: 3600, initialPriceBps: 10_000, depositUsdc: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof ChainError);
      assert.equal(error.kind, 'chain-input');
      return true;
    },
  );
});

test('rejects resolving an unnamed market', async () => {
  await assert.rejects(resolveOnChain(CONFIG, '', 'yes'), (error: unknown) => {
    assert.ok(error instanceof ChainError);
    assert.equal(error.kind, 'chain-input');
    return true;
  });
});
