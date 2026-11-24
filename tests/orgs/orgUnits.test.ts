import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Organisations (teams / business units): every send is made as one, and may use only that organisation's mailboxes.
 * The case this exists for: a Neev Labs mailbox must never send a Masai School email.
 */
const db = {
  orgUnit: {
    findUnique: vi.fn(async (_q: any): Promise<any> => null),
    findFirst: vi.fn(async (_q: any): Promise<any> => null),
    findMany: vi.fn(async (_q: any): Promise<any[]> => []),
  },
  user: { findUnique: vi.fn(async (_q: any): Promise<any> => null), findFirst: vi.fn(async (_q: any): Promise<any> => null), update: vi.fn(async (_q: any) => ({})) },
  workspace: { updateMany: vi.fn(async (_q: any) => ({ count: 1 })) },
  emailProviderAccount: { findFirst: vi.fn(async (_q: any): Promise<any> => null), findMany: vi.fn(async (_q: any): Promise<any[]> => []) },
  $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/audit/log', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/settings/org', () => ({ getOrgSettings: vi.fn(async () => ({ fallbackMailboxes: ['neev-box', 'masai-box', 'masai-gmail-box'] })), updateOrgSettings: vi.fn() }));

const units = await import('@/lib/orgs/units');
const fb = await import('@/lib/campaigns/fallback');
const { blastScope } = await import('@/lib/orgs/scope');

const MASAI = { id: 'o-masai', name: 'Masai School', domains: ['masaischool.com'] };
const NEEV = { id: 'o-neev', name: 'Neev Labs', domains: ['neevlabs.ai'] };
const OPEN = { id: 'o-ops', name: 'Operations', domains: [] as string[] };

beforeEach(() => {
  vi.clearAllMocks();
  db.orgUnit.findUnique.mockImplementation(async (q: any) => [MASAI, NEEV, OPEN].find((o) => o.id === q.where.id) ?? null);
  db.orgUnit.findFirst.mockImplementation(async (q: any) => [MASAI, NEEV, OPEN].find((o) => o.id === q.where.id) ?? null);
});

describe('domains', () => {
  it('are normalised: lower-case, no @, unique, only real domains', () => {
    expect(units.parseDomains('@Masaischool.com, neevlabs.ai; masaischool.com not a domain')).toEqual(['masaischool.com', 'neevlabs.ai']);
    expect(units.parseDomains(['A.B.com', ''])).toEqual(['a.b.com']);
    expect(units.parseDomains(null)).toEqual([]);
  });
  it('an organisation with no domains allows any; one with domains allows only those (exact domain, never a suffix)', () => {
    expect(units.domainAllowed([], 'x@anything.org')).toBe(true);
    expect(units.domainAllowed(['masaischool.com'], 'a@masaischool.com')).toBe(true);
    expect(units.domainAllowed(['masaischool.com'], 'a@neevlabs.ai')).toBe(false);
    expect(units.domainAllowed(['masaischool.com'], 'a@masaischool.com.evil.com')).toBe(false);
  });
  it('an approval suggests an organisation only when exactly one lists the domain', () => {
    expect(units.suggestOrgFor('a@neevlabs.ai', [MASAI, NEEV])).toBe('o-neev');
    expect(units.suggestOrgFor('a@gmail.com', [MASAI, NEEV])).toBeNull();
    expect(units.suggestOrgFor('a@masaischool.com', [MASAI, { ...OPEN, domains: ['masaischool.com'] }])).toBeNull();
  });
});

describe('who a send may be made as', () => {
  const sess = (role: string, orgUnitId: string | null) => ({ organizationId: 't1', role: role as any, orgUnitId });
  it('anyone sends as their own organisation by default', async () => {
    expect((await units.resolveSendOrg(sess('ADMIN', 'o-masai'))).name).toBe('Masai School');
  });
  it('only a Super Admin may send as another organisation', async () => {
    await expect(units.resolveSendOrg(sess('ADMIN', 'o-masai'), 'o-neev')).rejects.toThrow(/own organisation/);
    expect((await units.resolveSendOrg(sess('SUPER_ADMIN', 'o-masai'), 'o-neev')).name).toBe('Neev Labs');
  });
  it('someone with no organisation cannot send until a Super Admin assigns one', async () => {
    await expect(units.resolveSendOrg(sess('ADMIN', null))).rejects.toThrow(/no organisation/);
  });
});

describe('a mailbox may send only for its own organisation (the Neev Labs / Masai School case)', () => {
  it('a Neev Labs mailbox is refused for a Masai School send, with the reason', async () => {
    db.user.findUnique.mockResolvedValue({ orgUnitId: 'o-neev', orgUnit: { name: 'Neev Labs' } });
    const problem = await units.senderOrgProblem({ userId: 'u1', emailAddress: 'sam@neevlabs.ai' }, 'o-masai');
    expect(problem).toMatch(/belongs to Neev Labs, not Masai School/);
  });
  it('a member’s mailbox on a domain the organisation does not list is refused', async () => {
    db.user.findUnique.mockResolvedValue({ orgUnitId: 'o-masai', orgUnit: { name: 'Masai School' } });
    expect(await units.senderOrgProblem({ userId: 'u1', emailAddress: 'sam@gmail.com' }, 'o-masai')).toMatch(/not on Masai School's sender domains \(@masaischool\.com\)/);
  });
  it('a member’s own mailbox on the right domain is fine', async () => {
    db.user.findUnique.mockResolvedValue({ orgUnitId: 'o-masai', orgUnit: { name: 'Masai School' } });
    expect(await units.senderOrgProblem({ userId: 'u1', emailAddress: 'sam@masaischool.com' }, 'o-masai')).toBeNull();
  });
  it('a send with no organisation is refused', async () => {
    expect(await units.senderOrgProblem({ userId: 'u1', emailAddress: 'a@b.com' }, null)).toMatch(/no organisation/);
  });

  it('backup mailboxes offered are only the organisation’s own, opted in, on its domains', async () => {
    db.emailProviderAccount.findMany.mockImplementation(async (q: any) => {
      expect(q.where.user).toEqual({ orgUnitId: 'o-masai' }); // the query itself is limited to the organisation
      return [
        { id: 'masai-box', emailAddress: 'a@masaischool.com', status: 'CONNECTED', user: { name: 'A', status: 'ACTIVE' } },
        { id: 'masai-gmail-box', emailAddress: 'b@gmail.com', status: 'CONNECTED', user: { name: 'B', status: 'ACTIVE' } },
      ];
    });
    const list = await fb.availableFallbackMailboxes('t1', null, { orgUnitId: 'o-masai', domains: ['masaischool.com'] });
    expect(list.map((m) => m.id)).toEqual(['masai-box']); // the gmail one is on a domain the organisation does not list
  });
  it('no organisation means no backup mailboxes at all', async () => {
    expect(await fb.availableFallbackMailboxes('t1', null, null)).toEqual([]);
  });
  it('a chosen backup from another organisation is rejected', async () => {
    db.emailProviderAccount.findMany.mockResolvedValue([{ id: 'masai-box', emailAddress: 'a@masaischool.com', status: 'CONNECTED', user: { name: 'A', status: 'ACTIVE' } }]);
    const r = await fb.validateFallbackList('t1', 'main', ['neev-box'], { orgUnitId: 'o-masai', domains: ['masaischool.com'] });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).error).toMatch(/another organisation/);
  });
  it('the sender’s own mailbox counts only when they belong to the organisation', async () => {
    db.emailProviderAccount.findFirst.mockResolvedValue({ id: 'm1', emailAddress: 'sam@neevlabs.ai' });
    db.user.findUnique.mockResolvedValue({ orgUnitId: 'o-neev' });
    expect(await fb.ownMailboxIn('u1', { orgUnitId: 'o-masai', domains: [] })).toBeNull();
    expect((await fb.ownMailboxIn('u1', { orgUnitId: 'o-neev', domains: ['neevlabs.ai'] }))?.id).toBe('m1');
  });
});

describe('moving a person to another organisation', () => {
  const admin: any = { userId: 'sa', organizationId: 't1', role: 'SUPER_ADMIN', orgUnitId: 'o-masai' };
  it('moves the person and their workspace together', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u9', email: 'x@masaischool.com', orgUnitId: 'o-masai' });
    const r = await units.assignUserToOrg(admin, 'u9', 'o-ops');
    expect(r).toMatchObject({ changed: true });
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: 'u9' }, data: { orgUnitId: 'o-ops' } });
    expect(db.workspace.updateMany).toHaveBeenCalledWith({ where: { ownerId: 'u9' }, data: { orgUnitId: 'o-ops' } });
  });
  it('does nothing when they are already there, and refuses an organisation outside the company', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u9', email: 'x@masaischool.com', orgUnitId: 'o-ops' });
    expect(await units.assignUserToOrg(admin, 'u9', 'o-ops')).toMatchObject({ changed: false });
    expect(await units.assignUserToOrg(admin, 'u9', 'o-unknown')).toBeNull();
  });
});

describe('who sees Recruiter Bulk Send emails', () => {
  it('a Super Admin sees the whole company, and can narrow to an organisation or a sender', () => {
    expect(blastScope({ organizationId: 't1', role: 'SUPER_ADMIN' as any, orgUnitId: 'o-masai' })).toEqual({ AND: [{ organizationId: 't1' }] });
    expect(blastScope({ organizationId: 't1', role: 'SUPER_ADMIN' as any, orgUnitId: 'o-masai' }, { orgUnitId: 'o-neev', createdById: 'u3' })).toEqual({ AND: [{ organizationId: 't1' }, { orgUnitId: 'o-neev' }, { createdById: 'u3' }] });
  });
  it('an Admin sees only their organisation’s, whatever they ask for', () => {
    expect(blastScope({ organizationId: 't1', role: 'ADMIN' as any, orgUnitId: 'o-masai' }, { orgUnitId: 'o-neev' })).toEqual({ AND: [{ organizationId: 't1' }, { orgUnitId: 'o-masai' }] });
  });
  it('everyone else sees none', () => {
    expect(blastScope({ organizationId: 't1', role: 'OPERATOR' as any, orgUnitId: 'o-masai' })).toBeNull();
    expect(blastScope({ organizationId: 't1', role: 'ADMIN' as any, orgUnitId: null })).toBeNull();
  });
});
