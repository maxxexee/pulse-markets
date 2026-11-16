import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { signerFromKey } from '../../index-service/src/adapters/attestation.ts';
import {
  createMarketSpec,
  MarketError,
  type MarketDefinition,
} from '../src/domain/market.ts';

function validSigner(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signerFromKey(privateKey).publicKey;
}

function terms(overrides: Partial<MarketDefinition> = {}): MarketDefinition {
  return {
    definitionId: 'pulse-attention-v4',
    signer: validSigner(),
    threshold: 55,
    comparison: 'above',
    epochDay: '2026-11-20',
    minConfidence: 0.5,
    createdAt: '2026-11-16T09:00:00.000Z',
    ...overrides,
  };
}

test('identical terms derive the same id regardless of key order', () => {
  const definition = terms();
  const reordered = {
    createdAt: definition.createdAt,
    minConfidence: definition.minConfidence,
    epochDay: definition.epochDay,
    comparison: definition.comparison,
    threshold: definition.threshold,
    signer: definition.signer,
    definitionId: definition.definitionId,
  };
  assert.equal(createMarketSpec(reordered).id, createMarketSpec(definition).id);
  assert.match(createMarketSpec(definition).id, /^[0-9a-f]{64}$/);
});

test('changing any term changes the id', () => {
  const base = createMarketSpec(terms()).id;
  const variants: Partial<MarketDefinition>[] = [
    { threshold: 55.5 },
    { comparison: 'below' },
    { epochDay: '2026-11-21' },
    { definitionId: 'pulse-attention-v5' },
    { minConfidence: 0.6 },
    { createdAt: '2026-11-16T09:00:01.000Z' },
  ];
  for (const variant of variants) {
    assert.notEqual(createMarketSpec(terms(variant)).id, base, JSON.stringify(variant));
  }
});

test('rejects a threshold outside 0 to 100 or finer than two decimals', () => {
  for (const threshold of [-0.01, 100.01, Number.NaN, 55.005]) {
    assert.throws(
      () => createMarketSpec(terms({ threshold })),
      (error: unknown) => error instanceof MarketError && error.kind === 'invalid-threshold',
      `threshold ${threshold}`,
    );
  }
});

test('rejects an unknown comparison, a bad day and a non key signer', () => {
  assert.throws(
    () => createMarketSpec(terms({ comparison: 'equal' as 'above' })),
    (error: unknown) => error instanceof MarketError && error.kind === 'invalid-comparison',
  );
  assert.throws(
    () => createMarketSpec(terms({ epochDay: '2026-13-01' })),
    (error: unknown) => error instanceof MarketError && error.kind === 'invalid-day',
  );
  for (const signer of ['', 'not base58!', 'abc']) {
    assert.throws(
      () => createMarketSpec(terms({ signer })),
      (error: unknown) => error instanceof MarketError && error.kind === 'invalid-signer',
      signer,
    );
  }
});

test('rejects a confidence floor outside 0 to 1', () => {
  for (const minConfidence of [-0.1, 1.1, Number.NaN]) {
    assert.throws(
      () => createMarketSpec(terms({ minConfidence })),
      (error: unknown) => error instanceof MarketError && error.kind === 'invalid-confidence',
    );
  }
});
