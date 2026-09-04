import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';

describe('encryptSecret / decryptSecret', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  });

  it('round-trips a plaintext secret', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto/secretBox');
    const secret = 'ya29.a0AfH6...refresh-token-example';
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const { encryptSecret } = await import('@/lib/crypto/secretBox');
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a).not.toBe(b);
  });

  it('throws on a tampered payload', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto/secretBox');
    const encrypted = encryptSecret('secret');
    const tampered = encrypted.slice(0, -4) + 'abcd';
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
