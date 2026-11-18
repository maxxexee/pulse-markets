import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeBase58, encodeBase58 } from '../src/base58.ts';
import { canonicalJson, sha256Hex } from '../src/snapshot.ts';

describe('canonicalJson', () => {
  it('sorts keys so insertion order cannot change the hash', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it('sorts nested keys and preserves array order', () => {
    const value = { z: [{ d: 4, c: 3 }], y: { f: 6, e: 5 } };
    assert.equal(canonicalJson(value), '{"y":{"e":5,"f":6},"z":[{"c":3,"d":4}]}');
  });

  it('drops undefined values rather than writing null', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', () => {
    assert.equal(
      sha256Hex(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('base58', () => {
  it('encodes a single zero byte as one', () => {
    assert.equal(encodeBase58(new Uint8Array([0])), '1');
  });

  it('matches the reference encoding of a known string', () => {
    assert.equal(encodeBase58(new TextEncoder().encode('hello world')), 'StV1DL6CwTryKyV');
  });

  it('round trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3, 250, 251, 255, 7]);
    assert.deepEqual(decodeBase58(encodeBase58(bytes)), bytes);
  });

  it('rejects characters outside the alphabet', () => {
    assert.throws(() => decodeBase58('0OIl'), /invalid base58 character/);
  });
});
