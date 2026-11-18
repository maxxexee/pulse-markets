/**
 * Maps a value to its base58 string, using the Bitcoin alphabet that Solana
 * also uses for addresses.
 *
 * The attestation public key is published in base58 so that it is directly
 * recognisable as a Solana address and can be verified on chain later.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }

  const digits: number[] = [];
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index] ?? 0;
    for (let slot = 0; slot < digits.length; slot += 1) {
      carry += (digits[slot] ?? 0) * 256;
      digits[slot] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = '1'.repeat(zeros);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    out += ALPHABET[digits[index] ?? 0];
  }
  return out;
}

const INDEX_BY_CHAR = new Map<string, number>(
  [...ALPHABET].map((character, index) => [character, index]),
);

/**
 * Decodes a base58 string back to bytes.
 *
 * Throws on any character outside the alphabet, because a corrupted public key
 * must fail loudly rather than verify against the wrong bytes.
 */
export function decodeBase58(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') {
    zeros += 1;
  }

  const bytes: number[] = [];
  for (let position = zeros; position < text.length; position += 1) {
    const character = text[position] ?? '';
    const value = INDEX_BY_CHAR.get(character);
    if (value === undefined) {
      throw new Error(`invalid base58 character: ${character}`);
    }
    let carry = value;
    for (let slot = 0; slot < bytes.length; slot += 1) {
      carry += (bytes[slot] ?? 0) * 58;
      bytes[slot] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry % 256);
      carry = Math.floor(carry / 256);
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    out[out.length - 1 - index] = bytes[index] ?? 0;
  }
  return out;
}
