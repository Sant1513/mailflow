import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contacts API: "Last emailed" on the list, the "recently emailed" filter (database filter on the email key, exact total and
 * paging, combined with search), and the cool-off PATCH (permissions, validation, audit).
 */
const contact = (id: string, email: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: 'org1', workspaceId: 'w1', name: null, primaryEmail: email, doNotContactUntil: null, coolOffNote: null, _count: { records: 1, conversations: 0 }, ...extra });

const db = {
  contact: {
    findMany: vi.fn(async (_q: any): Promise<any[]> => []),
    count: vi.fn(async (_q: any) => 0),
    findUnique: vi.fn(async (_q: any): Promise<any> => null),
    update: vi.fn(async (q: any) => ({ id: q.where.id, ...q.data })),
  },
  $queryRaw: vi.fn(async (_sql: any): Promise<any[]> => []),
  auditLog: { create: vi.fn(async (_q: any) => ({})) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const session = { userId: 'u1', organizationId: 'org1', workspaceId: 'w1', role: 'OPERATOR' as string, viewingAs: null as any };
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig<any>()), requireSession: vi.fn(async () => session) }));
vi.mock('@/lib/permissions/workspace', async (orig) => ({ ...(await orig<any>()), resolveWorkspaceId: vi.fn(async () => 'w1') }));
const recent = {
  lastEmailed: vi.fn(async (_org: string, _emails: string[]) => new Map<string, any>()),
  recentlyEmailedKeys: vi.fn(async (_org: string, _days: number) => new Map<string, any>()),
};
vi.mock('@/lib/recruiterSend/recent', () => recent);

const list = await import('@/app/api/contacts/route');
const one = await import('@/app/api/contacts/[id]/route');
const get = (qs: string) => list.GET(new Request(`http://localhost/api/contacts?${qs}`), {});
const patch = (body: unknown) => one.PATCH(new Request('http://localhost/api/contacts/c1', { method: 'PATCH', body: JSON.stringify(body) }), { params: { id: 'c1' } });

beforeEach(() => {
  vi.clearAllMocks();
  session.role = 'OPERATOR';
  session.viewingAs = null;
  recent.lastEmailed.mockImplementation(async () => new Map());
  recent.recentlyEmailedKeys.mockImplementation(async () => new Map());
});

describe('GET /api/contacts', () => {
  it('without the filter pages with Prisma and never scans recent emails; attaches lastEmailed (gmail dots ignored)', async () => {
    db.contact.findMany.mockResolvedValueOnce([contact('c1', 'A.B@gmail.com'), contact('c2', 'x@y.com')]);
    db.contact.count.mockResolvedValueOnce(2);
    recent.lastEmailed.mockResolvedValueOnce(new Map([['ab@gmail.com', { at: new Date('2026-11-17T10:00:00Z'), subject: 'Hi', source: 'Inbox reply', from: 'me@x.com', kind: 'reply', pending: false, count: 1 }]]));
    const json = await (await get('q=a&page=1&pageSize=25')).json();
    expect(recent.recentlyEmailedKeys).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(json.total).toBe(2);
    expect(json.contacts[0].lastEmailed).toEqual({ at: '2026-11-17T10:00:00.000Z', subject: 'Hi', source: 'Inbox reply', from: 'me@x.com' });
    expect(json.contacts[1].lastEmailed).toBeNull();
    expect(recent.lastEmailed).toHaveBeenCalledWith('org1', ['A.B@gmail.com', 'x@y.com']);
  });

  it('within: filters in the database on the email key with search, paging and an exact total', async () => {
    recent.recentlyEmailedKeys.mockResolvedValueOnce(new Map([['a@b.com', {}], ['c@d.com', {}]]));
    db.$queryRaw.mockResolvedValueOnce([{ id: 'c2' }, { id: 'c1' }]).mockResolvedValueOnce([{ n: BigInt(57) }]);
    db.contact.findMany.mockResolvedValueOnce([contact('c1', 'a@b.com'), contact('c2', 'c@d.com')]);
    const json = await (await get('q=b&page=2&pageSize=25&emailed=within&emailedDays=7')).json();
    expect(recent.recentlyEmailedKeys).toHaveBeenCalledWith('org1', 7);
    expect(json.total).toBe(57);
    expect(json.pages).toBe(3);
    expect(json.page).toBe(2);
    expect(json.contacts.map((c: any) => c.id)).toEqual(['c2', 'c1']);
    const [idsSql, countSql] = db.$queryRaw.mock.calls.map((c) => c[0]);
    expect(idsSql.sql).toContain('mailflow_email_key("primaryEmail")');
    expect(idsSql.sql).toContain('ILIKE');
    expect(idsSql.sql).toContain('OFFSET');
    expect(idsSql.values).toContain(25);
    expect(idsSql.values).toContain('%b%');
    expect(countSql.sql).toContain('count(*)');
    expect(db.contact.count).not.toHaveBeenCalled();
  });

  it('within with nobody emailed returns nothing; not with nobody emailed returns everyone through the plain path', async () => {
    db.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 0 }]);
    const none = await (await get('emailed=within')).json();
    expect(none.contacts).toEqual([]);
    expect(none.total).toBe(0);

    db.contact.findMany.mockResolvedValueOnce([contact('c1', 'a@b.com')]);
    db.contact.count.mockResolvedValueOnce(1);
    const all = await (await get('emailed=not')).json();
    expect(all.total).toBe(1);
    expect(db.contact.count).toHaveBeenCalled();
  });
});

describe('PATCH /api/contacts/[id] cool-off', () => {
  beforeEach(() => db.contact.findUnique.mockResolvedValue(contact('c1', 'a@b.com')));

  it('sets the date (start of that day in India) and note, trims the note, and audits', async () => {
    const date = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const res = await patch({ doNotContactUntil: date, coolOffNote: '  on leave  ' });
    expect(res.status).toBe(200);
    const data = db.contact.update.mock.calls[0]![0].data;
    expect(data.coolOffNote).toBe('on leave');
    expect(data.doNotContactUntil.toISOString()).toBe(new Date(`${date}T00:00:00+05:30`).toISOString());
    expect(db.auditLog.create.mock.calls[0]![0].data).toMatchObject({ action: 'CONTACT_COOL_OFF_SET', targetType: 'Contact', targetId: 'c1', actorId: 'u1' });
  });

  it('null clears the date and the note and audits a clear', async () => {
    const res = await patch({ doNotContactUntil: null, coolOffNote: 'ignored' });
    expect(res.status).toBe(200);
    expect(db.contact.update.mock.calls[0]![0].data).toEqual({ doNotContactUntil: null, coolOffNote: null });
    expect(db.auditLog.create.mock.calls[0]![0].data.action).toBe('CONTACT_COOL_OFF_CLEARED');
  });

  it('rejects bad dates, far dates and long notes with 400 and writes nothing', async () => {
    expect((await patch({ doNotContactUntil: 'tomorrow' })).status).toBe(400);
    expect((await patch({ doNotContactUntil: '2099-01-01' })).status).toBe(400);
    expect((await patch({ doNotContactUntil: null, coolOffNote: 'x'.repeat(201) })).status).toBe(400);
    expect(db.contact.update).not.toHaveBeenCalled();
  });

  it('needs write access, not viewing another workspace, and the contact in your workspace', async () => {
    session.role = 'VIEWER';
    expect((await patch({ doNotContactUntil: null })).status).toBe(403);
    session.role = 'OPERATOR';
    session.viewingAs = { workspaceId: 'w9' };
    expect((await patch({ doNotContactUntil: null })).status).toBe(403);
    session.viewingAs = null;
    db.contact.findUnique.mockResolvedValue(contact('c1', 'a@b.com', { workspaceId: 'other' }));
    expect((await patch({ doNotContactUntil: null })).status).toBe(403);
    db.contact.findUnique.mockResolvedValue(null);
    expect((await patch({ doNotContactUntil: null })).status).toBe(404);
    expect(db.contact.update).not.toHaveBeenCalled();
  });
});
