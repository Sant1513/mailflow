import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Sign-up policy.
 *
 * ALLOWED_EMAIL_DOMAIN is optional: set it to lock sign-up to one domain,
 * leave it unset for open sign-up. Both modes are covered here, because
 * "open" must still reject junk (no email at all) and disabled accounts,
 * and "locked" must not be fooled by a lookalike domain.
 */
vi.mock('@/lib/db/client', () => ({
  prisma: {
    organization: { upsert: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    workspace: { create: vi.fn() },
  },
}));

vi.mock('@auth/prisma-adapter', () => ({ PrismaAdapter: () => ({}) }));

const ORIGINAL_ENV = { ...process.env };

async function load(domain?: string) {
  vi.resetModules();
  if (domain === undefined) delete process.env.ALLOWED_EMAIL_DOMAIN;
  else process.env.ALLOWED_EMAIL_DOMAIN = domain;
  const mod = await import('@/lib/auth/options');
  const { prisma } = await import('@/lib/db/client');
  (prisma.organization.upsert as any).mockResolvedValue({ id: 'org1' });
  (prisma.organization.findFirst as any).mockResolvedValue({ id: 'org1' });
  (prisma.organization.create as any).mockResolvedValue({ id: 'org1' });
  (prisma.user.findUnique as any).mockResolvedValue(null);
  (prisma.user.create as any).mockResolvedValue({ id: 'u1', name: 'Test User' });
  (prisma.workspace.create as any).mockResolvedValue({ id: 'ws1' });
  return { mod, prisma };
}

function callSignIn(mod: any, email: string | null) {
  return mod.authOptions.callbacks.signIn({
    user: { id: 'google-sub-1', email, name: 'Test User', image: null },
    account: { providerAccountId: 'google-sub-1' },
    profile: undefined,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isEmailAllowed — open sign-up (no ALLOWED_EMAIL_DOMAIN)', () => {
  it('accepts any real domain', async () => {
    const { mod } = await load(undefined);
    expect(mod.isEmailAllowed('someone@gmail.com')).toBe(true);
    expect(mod.isEmailAllowed('someone@masaischool.com')).toBe(true);
    expect(mod.isEmailAllowed('someone@anything.example')).toBe(true);
  });

  it('still requires an actual email address', async () => {
    const { mod } = await load(undefined);
    expect(mod.isEmailAllowed(null)).toBe(false);
    expect(mod.isEmailAllowed('')).toBe(false);
    expect(mod.isEmailAllowed('   ')).toBe(false);
    expect(mod.isEmailAllowed('not-an-email')).toBe(false);
  });

  it('reports no restriction', async () => {
    const { mod } = await load(undefined);
    expect(mod.allowedDomain()).toBeNull();
  });

  it('treats an empty/whitespace env value as unrestricted', async () => {
    const { mod } = await load('   ');
    expect(mod.allowedDomain()).toBeNull();
    expect(mod.isEmailAllowed('anyone@gmail.com')).toBe(true);
  });
});

describe('isEmailAllowed — locked to a domain', () => {
  it('accepts the configured domain, case-insensitively', async () => {
    const { mod } = await load('masaischool.com');
    expect(mod.isEmailAllowed('rahul@masaischool.com')).toBe(true);
    expect(mod.isEmailAllowed('Rahul@MasaiSchool.com')).toBe(true);
  });

  it('rejects other public domains', async () => {
    const { mod } = await load('masaischool.com');
    expect(mod.isEmailAllowed('someone@gmail.com')).toBe(false);
    expect(mod.isEmailAllowed('someone@yahoo.com')).toBe(false);
    expect(mod.isEmailAllowed('someone@outlook.com')).toBe(false);
  });

  it('rejects lookalike domains (full match, not a suffix)', async () => {
    const { mod } = await load('masaischool.com');
    expect(mod.isEmailAllowed('attacker@notmasaischool.com')).toBe(false);
    expect(mod.isEmailAllowed('attacker@masaischool.com.evil.com')).toBe(false);
  });
});

describe('signIn callback — gate only', () => {
  it('lets a gmail.com account through when sign-up is open', async () => {
    const { mod } = await load(undefined);
    await expect(callSignIn(mod, 'newperson@gmail.com')).resolves.toBe(true);
  });

  /**
   * Regression cover for OAuthAccountNotLinked.
   *
   * The signIn callback used to create the User itself. That left the row
   * with no linked Account, so NextAuth refused to attach the Google
   * identity to it and every real sign-in failed with "To confirm your
   * identity, sign in with the same account you used originally".
   * Provisioning belongs to adapter.createUser, which creates the user and
   * links the account as one flow.
   */
  it('does NOT create a user — that would break OAuth account linking', async () => {
    const { mod, prisma } = await load(undefined);
    await callSignIn(mod, 'newperson@gmail.com');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });

  it('rejects an account with no email', async () => {
    const { mod } = await load(undefined);
    await expect(callSignIn(mod, null)).resolves.toBe(false);
  });

  it('still rejects a DISABLED account', async () => {
    const { mod, prisma } = await load(undefined);
    (prisma.user.findUnique as any).mockResolvedValue({
      id: 'u9',
      status: 'DISABLED',
      email: 'disabled@gmail.com',
    });
    await expect(callSignIn(mod, 'disabled@gmail.com')).resolves.toBe(false);
  });
});

describe('adapter.createUser — provisioning', () => {
  async function createUser(mod: any, email: string, name?: string) {
    return mod.authOptions.adapter.createUser({ id: 'x', email, name, emailVerified: null, image: null });
  }

  it('creates the user with an organization, role and personal workspace', async () => {
    const { mod, prisma } = await load(undefined);
    (prisma.user.create as any).mockResolvedValue({
      id: 'u1', email: 'new@gmail.com', name: 'New', image: null, emailVerified: null,
    });

    const result = await createUser(mod, 'new@gmail.com', 'New');

    expect(prisma.user.create).toHaveBeenCalled();
    const created = (prisma.user.create as any).mock.calls[0][0].data;
    expect(created.organizationId).toBe('org1');
    expect(created.role).toBe('OPERATOR');
    expect(prisma.workspace.create).toHaveBeenCalled();
    // NextAuth needs these exact fields back to continue the flow.
    expect(result).toMatchObject({ id: 'u1', email: 'new@gmail.com' });
  });

  it('reuses the existing organization so users are not split across tenants', async () => {
    const { mod, prisma } = await load(undefined);
    (prisma.user.create as any).mockResolvedValue({ id: 'u1', email: 'a@gmail.com', name: 'a', image: null, emailVerified: null });
    await createUser(mod, 'a@gmail.com', 'a');
    expect(prisma.organization.findFirst).toHaveBeenCalled();
    expect(prisma.organization.create).not.toHaveBeenCalled();
  });

  it('creates an organization when none exists yet', async () => {
    const { mod, prisma } = await load(undefined);
    (prisma.organization.findFirst as any).mockResolvedValue(null);
    (prisma.user.create as any).mockResolvedValue({ id: 'u1', email: 'a@gmail.com', name: 'a', image: null, emailVerified: null });
    await createUser(mod, 'a@gmail.com', 'a');
    expect(prisma.organization.create).toHaveBeenCalled();
  });

  it('falls back to the address local part when Google sends no name', async () => {
    const { mod, prisma } = await load(undefined);
    (prisma.user.create as any).mockResolvedValue({ id: 'u1', email: 'noname@gmail.com', name: 'noname', image: null, emailVerified: null });
    await createUser(mod, 'noname@gmail.com', undefined);
    expect((prisma.user.create as any).mock.calls[0][0].data.name).toBe('noname');
  });

  it('lowercases the stored email so lookups match', async () => {
    const { mod, prisma } = await load(undefined);
    (prisma.user.create as any).mockResolvedValue({ id: 'u1', email: 'mixed@gmail.com', name: 'x', image: null, emailVerified: null });
    await createUser(mod, 'MiXeD@Gmail.com', 'x');
    expect((prisma.user.create as any).mock.calls[0][0].data.email).toBe('mixed@gmail.com');
  });
});

describe('events.signIn — records sign-in metadata', () => {
  function fireSignIn(mod: any, email: string, providerAccountId?: string) {
    return mod.authOptions.events.signIn({
      user: { id: 'u1', email },
      account: providerAccountId
        ? { provider: 'google', type: 'oauth', providerAccountId }
        : null,
    });
  }

  it('stores lastLoginAt and backfills googleId from the linked account', async () => {
    const { mod, prisma } = await load(undefined);
    (prisma.user.update as any).mockResolvedValue({});
    await fireSignIn(mod, 'Existing@Gmail.com', 'google-sub-123');
    const call = (prisma.user.update as any).mock.calls[0][0];
    expect(call.where).toEqual({ email: 'existing@gmail.com' });
    expect(call.data.googleId).toBe('google-sub-123');
    expect(call.data.lastLoginAt).toBeInstanceOf(Date);
  });

  it('never fails a successful login over bookkeeping', async () => {
    const { mod, prisma } = await load(undefined);
    (prisma.user.update as any).mockRejectedValue(new Error('db down'));
    await expect(fireSignIn(mod, 'a@gmail.com')).resolves.toBeUndefined();
  });
});

describe('signIn callback — locked to a domain', () => {
  it('rejects a non-matching domain and creates nothing', async () => {
    const { mod, prisma } = await load('masaischool.com');
    await expect(callSignIn(mod, 'someone@gmail.com')).resolves.toBe(false);
    expect(prisma.organization.upsert).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });

  it('accepts a matching domain', async () => {
    const { mod } = await load('masaischool.com');
    await expect(callSignIn(mod, 'rahul@masaischool.com')).resolves.toBe(true);
  });
});
