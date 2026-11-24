import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An expired or disabled organisation is locked (docs/org-lifecycle.md): its people's API calls answer 402, nothing it queued is sent,
 * and everything resumes when it is renewed. Grace and "expiring" are not locked. Super Admins are never locked.
 */
const NOW = Date.now();
const day = 86_400_000;
const orgs: Record<string, { name: string; status: string; validUntil: Date | null; graceDays: number }> = {};
const db = {
  orgUnit: { findUnique: vi.fn(async (q: any) => orgs[q.where.id] ?? null) },
  workspace: { findUnique: vi.fn(async () => ({ orgUnitId: 'ou-expired' })) },
  batch: { findUniqueOrThrow: vi.fn(async () => ({ id: 'b1', status: 'RUNNING', campaignId: 'c1' })) },
  campaign: { findUnique: vi.fn(async () => ({ orgUnitId: 'ou-expired', createdById: 'u1' })) },
  emailJob: { count: vi.fn(async () => 7) },
  user: { findUnique: vi.fn(async () => null) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const state: { user: Record<string, unknown> | null } = { user: null };
vi.mock('next-auth', () => ({ getServerSession: async () => (state.user ? { user: state.user } : null) }));
vi.mock('next/headers', () => ({ cookies: () => ({ get: () => undefined }) }));
vi.mock('@/lib/auth/options', () => ({ authOptions: {} }));

const access = await import('@/lib/orgs/access');
const { requireSession, OrgLockedError } = await import('@/lib/auth/session');
const { withErrorHandling } = await import('@/lib/api/respond');
const { drainBatch } = await import('@/lib/queue/drain');

const user = (over: Record<string, unknown> = {}) => ({ id: 'u1', organizationId: 't1', orgUnitId: 'ou-expired', workspaceId: 'w1', role: 'ADMIN', status: 'ACTIVE', email: 'a@x.com', name: 'A', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  access.resetOrgAccessCache();
  state.user = null;
  orgs['ou-ok'] = { name: 'Operations', status: 'ACTIVE', validUntil: null, graceDays: 0 };
  orgs['ou-expiring'] = { name: 'HR', status: 'ACTIVE', validUntil: new Date(NOW + 5 * day), graceDays: 0 };
  orgs['ou-grace'] = { name: 'Tech', status: 'ACTIVE', validUntil: new Date(NOW - 1 * day), graceDays: 5 };
  orgs['ou-expired'] = { name: 'Neev Labs', status: 'ACTIVE', validUntil: new Date(NOW - 3 * day), graceDays: 0 };
  orgs['ou-disabled'] = { name: 'Curriculum', status: 'DISABLED', validUntil: null, graceDays: 0 };
});

describe('which organisations are locked', () => {
  it('only an expired (past grace) or disabled one', async () => {
    expect(await access.isOrgLocked('ou-ok')).toBe(false);
    expect(await access.isOrgLocked('ou-expiring')).toBe(false);
    expect(await access.isOrgLocked('ou-grace')).toBe(false);
    expect(await access.isOrgLocked('ou-expired')).toBe(true);
    expect(await access.isOrgLocked('ou-disabled')).toBe(true);
  });
  it('someone with no organisation, or an unknown one, is never locked', async () => {
    expect(await access.isOrgLocked(null)).toBe(false);
    expect(await access.isOrgLocked('missing')).toBe(false);
  });
  it('the lock says why, with a code', async () => {
    expect(await access.orgLockOf('ou-expired')).toMatchObject({ code: 'ORG_EXPIRED', lock: 'dashboard', orgName: 'Neev Labs' });
    expect(await access.orgLockOf('ou-disabled')).toMatchObject({ code: 'ORG_DISABLED', lock: 'full' });
    expect(await access.orgLockOf('ou-ok')).toBeNull();
  });
  it('is remembered for a minute (one lookup, not one per request)', async () => {
    await access.isOrgLocked('ou-ok');
    await access.isOrgLocked('ou-ok');
    expect(db.orgUnit.findUnique).toHaveBeenCalledTimes(1);
    access.resetOrgAccessCache('ou-ok');
    await access.isOrgLocked('ou-ok');
    expect(db.orgUnit.findUnique).toHaveBeenCalledTimes(2);
  });
  it('Super Admins are never locked', async () => {
    expect(await access.orgAccessOfSession({ role: 'SUPER_ADMIN', orgUnitId: 'ou-disabled' })).toBeNull();
    expect((await access.orgAccessOfSession({ role: 'ADMIN', orgUnitId: 'ou-disabled' }))?.access.state).toBe('DISABLED');
  });
});

describe('the API', () => {
  it('answers a locked organisation’s people with 402 and a code', async () => {
    state.user = user();
    await expect(requireSession()).rejects.toBeInstanceOf(OrgLockedError);
    const res = await withErrorHandling(async () => { await requireSession(); throw new Error('unreachable'); })(new Request('http://x'), {});
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'ORG_EXPIRED', error: expect.stringMatching(/Neev Labs/) });
  });
  it('a disabled organisation is 402 with its own code', async () => {
    state.user = user({ orgUnitId: 'ou-disabled' });
    await expect(requireSession()).rejects.toMatchObject({ status: 402, code: 'ORG_DISABLED' });
  });
  it('the few routes the lock screen needs opt in with allowLocked', async () => {
    state.user = user();
    await expect(requireSession({ allowLocked: true })).resolves.toMatchObject({ userId: 'u1' });
  });
  it('open, expiring and grace organisations work normally, and so does a Super Admin of a locked one', async () => {
    for (const id of ['ou-ok', 'ou-expiring', 'ou-grace']) {
      state.user = user({ orgUnitId: id });
      await expect(requireSession()).resolves.toMatchObject({ userId: 'u1' });
    }
    state.user = user({ role: 'SUPER_ADMIN', orgUnitId: 'ou-disabled' });
    await expect(requireSession()).resolves.toMatchObject({ role: 'SUPER_ADMIN' });
  });
  it('a person with no organisation (not yet assigned) is not blocked by this check', async () => {
    state.user = user({ orgUnitId: null });
    await expect(requireSession()).resolves.toMatchObject({ userId: 'u1' });
    expect(db.orgUnit.findUnique).not.toHaveBeenCalled();
  });
});

describe('sending is held, not failed', () => {
  it('a campaign batch of a locked organisation sends nothing and stays queued', async () => {
    const r = await drainBatch('b1', 10);
    expect(r).toMatchObject({ processed: 0, sent: 0, failed: 0, remaining: 7, lockedReason: expect.stringMatching(/Paused: Neev Labs/) });
  });
  it('the words used for a held send', async () => {
    expect(await access.sendLockReason('ou-expired')).toBe('Paused: Neev Labs’s access has expired');
    expect(await access.sendLockReason('ou-disabled')).toBe('Paused: Curriculum is disabled');
    expect(await access.sendLockReason('ou-ok')).toBeNull();
  });
});
