import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { decodeBase58, encodeBase58 } from './base58.ts';
import { canonicalJson, sha256Hex, type IndexSnapshot } from './snapshot.ts';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo, ahead of the 32 raw key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

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

export interface Signer {
  /** Base58 public key. Ed25519 keys are 32 bytes, so this is a Solana address. */
  readonly publicKey: string;
  sign(payload: Uint8Array): Uint8Array;
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

/** Bytes a snapshot's signature covers, derived from the snapshot alone. */
export function signingPayload(snapshot: IndexSnapshot): Buffer {
  return Buffer.from(canonicalJson(snapshot), 'utf8');
}

/** Signs any canonical document with the publisher key. */
export function signPayload(payload: Uint8Array, signer: Signer): Attestation {
  return {
    alg: 'ed25519',
    publicKey: signer.publicKey,
    signature: Buffer.from(signer.sign(payload)).toString('base64'),
    payloadSha256: sha256Hex(payload),
    canonicalization: 'json-sorted-keys-v1',
  };
}

/** Signs a snapshot over its canonical serialisation. */
export function signSnapshot(snapshot: IndexSnapshot, signer: Signer): SignedSnapshot {
  const payload = signingPayload(snapshot);
  return { snapshot, attestation: signPayload(payload, signer) };
}

/**
 * Checks that a signed snapshot is internally consistent.
 *
 * Verifies both that the payload hash matches the snapshot and that the
 * signature is valid for the published public key. A caller that trusts the
 * signer address can then accept the snapshot without trusting the publisher.
 */
export function verifySignedSnapshot(signed: SignedSnapshot): boolean {
  return verifyAttestation(signingPayload(signed.snapshot), signed.attestation);
}

/**
 * Checks a signature against arbitrary canonical bytes.
 *
 * Shared by the index snapshot and the signed trend epoch so both documents
 * have exactly one verification rule.
 */
export function verifyAttestation(payload: Uint8Array, attestation: Attestation): boolean {
  if (sha256Hex(payload) !== attestation.payloadSha256) {
    return false;
  }
  if (attestation.alg !== 'ed25519') {
    return false;
  }
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(decodeBase58(attestation.publicKey)),
      ]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return false;
  }
  try {
    return verify(
      null,
      payload,
      publicKey,
      Buffer.from(attestation.signature, 'base64'),
    );
  } catch {
    return false;
  }
}
