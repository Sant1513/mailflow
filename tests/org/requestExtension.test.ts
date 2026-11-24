import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Request extension" (the one thing the lock screen offers): tells every active Super Admin, once per organisation every 12 hours.
 * The status route answers while locked and shows seat numbers to admins only.
 */
const db = {
  auditLog: { findFirst: vi.fn(async (_q: any): Promise<any> => null) },
  orgUnit: { findUnique: vi.fn(async (_q: any): Promise<any> => ({ name: 'Neev Labs', status: 'ACTIVE', validUntil: null, graceDays: 0, seatLimit: 5, id: 'o1' })) },
  user: {
    findMany: vi.fn(async (_q: any): Promise<any[]> => [{ id: 'sa1', ownedWorkspaces: [{ id: 'w-sa1' }] }, { id: 'sa2', ownedWorkspaces: [] }]),
    count: vi.fn(async (_q: any) => 3),
  },
  notification: { createMany: vi.fn(async (_q: any) => ({ count: 1 })) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const audit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/audit/log', () => ({ audit: (...a: unknown[]) => audit(...a) }));
const session: any = { userId: 'u1', organizationId: 't1', orgUnitId: 'o1', role: 'OPERATOR', email: 'sam@neevlabs.ai', name: 'Sam' };
const requireSession = vi.fn(async (_opts?: unknown) => session);
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig<any>()), requireSession: (o?: unknown) => requireSession(o) }));

const { POST } = await import('@/app/api/org/request-extension/route');
const { GET } = await import('@/app/api/org/status/route');
const post = (body?: unknown) => POST(new Request('http://x/api/org/request-extension', { method: 'POST', body: body ? JSON.stringify(body) : undefined }), {});

beforeEach(() => {
  vi.clearAllMocks();
  session.role = 'OPERATOR';
  session.orgUnitId = 'o1';
  db.auditLog.findFirst.mockResolvedValue(null);
  db.user.findMany.mockResolvedValue([{ id: 'sa1', ownedWorkspaces: [{ id: 'w-sa1' }] }, { id: 'sa2', ownedWorkspaces: [] }]);
});

describe('POST /api/org/request-extension', () => {
  it('works while the organisation is locked (it asks for the locked-allowed session)', async () => {
    await post();
    expect(requireSession).toHaveBeenCalledWith({ allowLocked: true });
  });

  it('notifies every active Super Admin who has a workspace, and audits it', async () => {
    const res = await post({ message: 'Paid on 28 Nov, ref 12345' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, notified: 1 });
    const rows = db.notification.createMany.mock.calls[0]![0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'sa1', workspaceId: 'w-sa1', type: 'ORG_RENEWAL_REQUEST', link: '/admin/organisations' });
    expect(rows[0].title).toBe('Neev Labs asked to renew');
    expect(rows[0].body).toContain('Sam (sam@neevlabs.ai)');
    expect(rows[0].body).toContain('Paid on 28 Nov, ref 12345');
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'ORG_EXTENSION_REQUEST', expect.objectContaining({ targetType: 'OrgUnit', targetId: 'o1' }));
  });

  it('a second request within 12 hours is refused with a friendly message, and tells nobody again', async () => {
    db.auditLog.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 2 * 3_600_000) });
    const res = await post();
    expect(res.status).toBe(429);
    const j = await res.json();
    expect(j.alreadySent).toBe(true);
    expect(j.error).toMatch(/already sent/);
    expect(db.notification.createMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    // the cooldown is looked up per organisation, over the last 12 hours
    const where = db.auditLog.findFirst.mock.calls[0]![0].where;
    expect(where).toMatchObject({ action: 'ORG_EXTENSION_REQUEST', targetId: 'o1' });
    expect(Date.now() - where.createdAt.gt.getTime()).toBeGreaterThan(11.9 * 3_600_000);
  });

  it('someone with no organisation cannot ask', async () => {
    session.orgUnitId = null;
    expect((await post()).status).toBe(400);
  });

  it('refuses a message longer than 500 characters', async () => {
    expect((await post({ message: 'x'.repeat(501) })).status).toBe(400);
  });
});

describe('GET /api/org/status', () => {
  const get = () => GET(new Request('http://x/api/org/status'), {});
  beforeEach(() => db.user.findMany.mockResolvedValue([{ name: 'Asha', email: 'asha@masaischool.com' }]));

  it('answers while locked, with the state, the words and who to contact', async () => {
    db.orgUnit.findUnique.mockResolvedValue({ id: 'o1', name: 'Neev Labs', status: 'DISABLED', validUntil: null, graceDays: 0, seatLimit: null });
    const res = await get();
    expect(requireSession).toHaveBeenCalledWith({ allowLocked: true });
    const j = await res.json();
    expect(j).toMatchObject({ org: { id: 'o1', name: 'Neev Labs' }, state: 'DISABLED', contacts: [{ name: 'Asha', email: 'asha@masaischool.com' }] });
    expect(j.message.title).toBe('Neev Labs is disabled');
    expect(j.seats).toBeUndefined();
  });

  it('shows the seat numbers to an Admin, not to an ordinary person', async () => {
    db.orgUnit.findUnique.mockResolvedValue({ id: 'o1', name: 'Neev Labs', status: 'ACTIVE', validUntil: null, graceDays: 0, seatLimit: 5 });
    session.role = 'ADMIN';
    expect((await (await get()).json()).seats).toEqual({ used: 3, limit: 5 });
    session.role = 'OPERATOR';
    expect((await (await get()).json()).seats).toBeUndefined();
  });

  it('a person with no organisation just gets the empty answer', async () => {
    session.orgUnitId = null;
    expect(await (await get()).json()).toMatchObject({ org: null, state: 'ACTIVE', message: null });
  });
});
