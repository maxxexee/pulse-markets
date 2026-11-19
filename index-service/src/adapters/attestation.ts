import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { signerFromKey, type Signer } from '@pulse/index-core/attestation.ts';

export {
  signSnapshot,
  signerFromKey,
  verifySignedSnapshot,
} from '@pulse/index-core/attestation.ts';
export type { Attestation, SignedSnapshot, Signer } from '@pulse/index-core/attestation.ts';

/**
 * Loads the snapshot signing key, creating it on first use.
 *
 * The key file holds the index identity: if it is lost, previously published
 * snapshots can no longer be added to under the same signer, so it is kept
 * outside version control and backed up.
 */
/** Loads the key only when it already exists, never creating a new identity. */
export function loadSignerIfPresent(keyPath: string): Signer | null {
  if (!existsSync(keyPath)) {
    return null;
  }
  return signerFromKey(createPrivateKey(readFileSync(keyPath, 'utf8')));
}

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
