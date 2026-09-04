import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * §5 / acceptance criterion #2: only @masaischool.com accounts may sign in.
 * This exercises the real signIn callback from lib/auth/options.ts — the
 * single gate every Google login passes through.
 */
vi.mock('@/lib/db/client', () => ({
  prisma: {
    organization: { upsert: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    workspace: { create: vi.fn() },
  },
}));

vi.mock('@auth/prisma-adapter', () => ({ PrismaAdapter: () => ({}) }));

const { prisma } = await import('@/lib/db/client');
const { authOptions } = await import('@/lib/auth/options');

const signIn = authOptions.callbacks!.signIn!;

function callSignIn(email: string) {
  return signIn({
    user: { id: 'google-sub-1', email, name: 'Test User', image: null } as any,
    account: { providerAccountId: 'google-sub-1' } as any,
    profile: undefined,
  });
}

describe('signIn domain restriction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.organization.upsert as any).mockResolvedValue({ id: 'org1' });
    (prisma.user.findUnique as any).mockResolvedValue(null);
    (prisma.user.create as any).mockResolvedValue({ id: 'u1', name: 'Test User' });
    (prisma.workspace.create as any).mockResolvedValue({ id: 'ws1' });
  });

  it('allows an @masaischool.com account', async () => {
    await expect(callSignIn('rahul@masaischool.com')).resolves.toBe(true);
  });

  it('rejects gmail.com', async () => {
    await expect(callSignIn('someone@gmail.com')).resolves.toBe(false);
  });

  it('rejects yahoo.com and outlook.com', async () => {
    await expect(callSignIn('someone@yahoo.com')).resolves.toBe(false);
    await expect(callSignIn('someone@outlook.com')).resolves.toBe(false);
  });

  it('rejects a lookalike domain (not a suffix match)', async () => {
    await expect(callSignIn('attacker@notmasaischool.com')).resolves.toBe(false);
    await expect(callSignIn('attacker@masaischool.com.evil.com')).resolves.toBe(false);
  });

  it('rejects an account with no email at all', async () => {
    await expect(
      signIn({ user: { id: 'x', email: null } as any, account: null as any, profile: undefined })
    ).resolves.toBe(false);
  });

  it('does not create any org/user/workspace rows for a rejected domain', async () => {
    await callSignIn('someone@gmail.com');
    expect(prisma.organization.upsert).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });

  it('provisions org + user + personal workspace on first allowed sign-in', async () => {
    await callSignIn('newjoiner@masaischool.com');
    expect(prisma.organization.upsert).toHaveBeenCalled();
    expect(prisma.user.create).toHaveBeenCalled();
    expect(prisma.workspace.create).toHaveBeenCalled();
  });

  it('rejects a DISABLED existing user even on the allowed domain', async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      id: 'u9',
      status: 'DISABLED',
      email: 'disabled@masaischool.com',
    });
    await expect(callSignIn('disabled@masaischool.com')).resolves.toBe(false);
  });

  it('updates lastLoginAt for an existing active user', async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      id: 'u2',
      status: 'ACTIVE',
      email: 'existing@masaischool.com',
    });
    await expect(callSignIn('existing@masaischool.com')).resolves.toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u2' } })
    );
  });

  it('is case-insensitive about the domain', async () => {
    await expect(callSignIn('Someone@MasaiSchool.com')).resolves.toBe(true);
  });
});
