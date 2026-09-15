import crypto from 'node:crypto';

/** Crockford base32: no I, L, O, U — easy to read aloud and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A short, stable reference for one generated copy of a document, e.g.
 * MF-7K2Q9PX4. Derived from the email job + campaign document ids, so
 * regenerating the copy later reproduces the same reference.
 */
export function documentReference(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest();
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of hash) {
    value = ((value << 8) | byte) & 0xfffff;
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 8) break;
  }
  return `MF-${out}`;
}

export const PREVIEW_REFERENCE = 'MF-PREVIEW';

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
