import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeBase58, encodeBase58 } from '../domain/base58.ts';
import { canonicalJson, sha256Hex, type IndexSnapshot } from '../domain/snapshot.ts';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo, ahead of the 32 raw key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface Signer {
  /** Base58 public key. Ed25519 keys are 32 bytes, so this is a Solana address. */
  readonly publicKey: string;
  sign(payload: Uint8Array): Uint8Array;
}

export interface Attestation {
  readonly alg: 'ed25519';
  readonly publicKey: string;
  /** Base64 signature over the canonical payload bytes. */
  readonly signature: string;
  /** Hex SHA-256 of the canonical payload, so the signed bytes can be checked. */
  readonly payloadSha256: string;
  readonly canonicalization: 'json-sorted-keys-v1';
}

export interface SignedSnapshot {
  readonly snapshot: IndexSnapshot;
  readonly attestation: Attestation;
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ type: 'spki', format: 'der' });
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Wraps an Ed25519 private key in the narrow interface the publisher needs. */
export function signerFromKey(privateKey: KeyObject): Signer {
  const publicKey = createPublicKey(privateKey);
  return {
    publicKey: encodeBase58(rawPublicKey(publicKey)),
    sign: (payload) => new Uint8Array(sign(null, payload, privateKey)),
  };
}

/**
 * Loads the snapshot signing key, creating it on first use.
 *
 * The key file holds the index identity: if it is lost, previously published
 * snapshots can no longer be added to under the same signer, so it is kept
 * outside version control and backed up.
 */
export function loadOrCreateSigner(keyPath: string): Signer {
  if (existsSync(keyPath)) {
    return signerFromKey(createPrivateKey(readFileSync(keyPath, 'utf8')));
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
    mode: 0o600,
  });
  return signerFromKey(privateKey);
}

/** Signs a snapshot over its canonical serialisation. */
export function signSnapshot(snapshot: IndexSnapshot, signer: Signer): SignedSnapshot {
  const payload = Buffer.from(canonicalJson(snapshot), 'utf8');
  const signature = signer.sign(payload);
  return {
    snapshot,
    attestation: {
      alg: 'ed25519',
      publicKey: signer.publicKey,
      signature: Buffer.from(signature).toString('base64'),
      payloadSha256: sha256Hex(payload),
      canonicalization: 'json-sorted-keys-v1',
    },
  };
}

/**
 * Checks that a signed snapshot is internally consistent.
 *
 * Verifies both that the payload hash matches the snapshot and that the
 * signature is valid for the published public key. A caller that trusts the
 * signer address can then accept the snapshot without trusting the publisher.
 */
export function verifySignedSnapshot(signed: SignedSnapshot): boolean {
  const payload = Buffer.from(canonicalJson(signed.snapshot), 'utf8');
  if (sha256Hex(payload) !== signed.attestation.payloadSha256) {
    return false;
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(decodeBase58(signed.attestation.publicKey))]),
    format: 'der',
    type: 'spki',
  });
  return verify(
    null,
    payload,
    publicKey,
    Buffer.from(signed.attestation.signature, 'base64'),
  );
}
