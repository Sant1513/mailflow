import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression cover for the production NO_SECRET outage.
 *
 * NextAuth v4 only auto-reads NEXTAUTH_SECRET; AUTH_SECRET is the Auth.js v5
 * name. The deployment was configured with AUTH_SECRET only, so NextAuth
 * started with no secret and every request to a page calling
 * getServerSession returned a 500 — invisible in development, because a
 * secret is only *required* in production.
 *
 * These tests pin the resolution rule and the fail-fast behaviour.
 */
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@auth/prisma-adapter', () => ({ PrismaAdapter: () => ({}) }));

const ORIGINAL_ENV = { ...process.env };

async function loadOptions() {
  vi.resetModules();
  const mod = await import('@/lib/auth/options');
  return mod.authOptions;
}

describe('session secret resolution', () => {
  beforeEach(() => {
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.AUTH_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('uses NEXTAUTH_SECRET when set (the NextAuth v4 name)', async () => {
    process.env.NEXTAUTH_SECRET = 'from-nextauth-secret';
    const options = await loadOptions();
    expect(options.secret).toBe('from-nextauth-secret');
  });

  it('falls back to AUTH_SECRET (the Auth.js v5 name)', async () => {
    process.env.AUTH_SECRET = 'from-auth-secret';
    const options = await loadOptions();
    expect(options.secret).toBe('from-auth-secret');
  });

  it('prefers NEXTAUTH_SECRET when both are set', async () => {
    process.env.NEXTAUTH_SECRET = 'preferred';
    process.env.AUTH_SECRET = 'ignored';
    const options = await loadOptions();
    expect(options.secret).toBe('preferred');
  });

  it('throws a clear error in production when neither is set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(loadOptions()).rejects.toThrow(/NEXTAUTH_SECRET/);
    vi.unstubAllEnvs();
  });

  it('allows a missing secret in development (NextAuth does not require one)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const options = await loadOptions();
    expect(options.secret).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
