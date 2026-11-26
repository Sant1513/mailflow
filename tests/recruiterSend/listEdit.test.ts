import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRow, cleanDomains, cleanEmail, domainsWhere, listOrderBy, parseListSort, splitDuplicates } from '@/lib/recruiterSend/listEdit';

describe('list edit helpers', () => {
  it('cleans an address out of "Name <email>" and rejects what is not one', () => {
    expect(cleanEmail(' Asha <ASHA@Acme.com> ')).toBe('asha@acme.com');
    expect(cleanEmail('not an email')).toBeNull();
    expect(cleanEmail('')).toBeNull();
  });
  it('a row with columns keeps the whole row, puts the address in its column and reads the name', () => {
    expect(buildRow({ email: 'x@acme.com', data: { Name: ' Asha ', Link: 'u' } }, ['Email Id', 'Name', 'Link'], 'Email Id')).toEqual({ email: 'x@acme.com', name: 'Asha', data: { 'Email Id': 'x@acme.com', Name: 'Asha', Link: 'u' } });
    expect(buildRow({ email: 'bad' }, ['Email'], 'Email')).toEqual({ error: 'That is not a valid email address.' });
  });
  it('a plain list keeps address and name only', () => {
    expect(buildRow({ email: 'x@acme.com', name: 'Asha' }, [], null)).toEqual({ email: 'x@acme.com', name: 'Asha', data: null });
  });
  it('domains: bare lower-case, no junk, no repeats', () => {
    expect(cleanDomains('@Acme.com, acme.com,  gmail.com ,nonsense, x y.com')).toEqual(['acme.com', 'gmail.com']);
    expect(cleanDomains(['@A.in'])).toEqual(['a.in']);
    expect(domainsWhere([])).toEqual({});
    expect(domainsWhere(['acme.com'])).toEqual({ OR: [{ email: { endsWith: '@acme.com', mode: 'insensitive' } }] });
  });
  it('only known sort columns; the sheet order is the default', () => {
    expect(parseListSort('evil', null)).toEqual({ sort: 'order', dir: 'asc' });
    expect(parseListSort('email', 'desc')).toEqual({ sort: 'email', dir: 'desc' });
    expect(listOrderBy('order', 'asc')).toEqual([{ id: 'asc' }]);
    expect(listOrderBy('email', 'desc')).toEqual([{ email: 'desc' }, { id: 'asc' }]);
  });
  it('the same Gmail inbox written another way is a duplicate, also within the new rows', () => {
    const { fresh, duplicates } = splitDuplicates([{ email: 'a.b@gmail.com' }, { email: 'ab+x@gmail.com' }, { email: 'c@acme.com' }, { email: 'z@acme.com' }], new Set(['z@acme.com']));
    expect(fresh.map((r) => r.email)).toEqual(['a.b@gmail.com', 'c@acme.com']);
    expect(duplicates.map((r) => r.email)).toEqual(['ab+x@gmail.com', 'z@acme.com']);
  });
});

const db = {
  recruiterBlast: { findUnique: vi.fn() },
  recruiterBlastRecipient: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn(async (a: any) => ({ id: 'n1', status: 'PENDING', ...a.data })), deleteMany: vi.fn() },
  $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  $queryRaw: vi.fn(async (): Promise<any[]> => []),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/campaigns/fallback', () => ({ availableFallbackMailboxes: vi.fn(), ownMailbox: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/recruiterSend/plan', () => ({ forgetPlan: vi.fn() }));
const session: Record<string, unknown> = { userId: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'ADMIN', viewingAs: null };
vi.mock('@/lib/auth/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...real, requireRole: vi.fn(async () => session) };
});
const { POST, PATCH, DELETE } = await import('@/app/api/recruiter-blasts/[id]/recipients/items/route');
const call = (fn: any, body: unknown) => fn(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }) as any, { params: { id: 'b1' } } as any);
const blast = { id: 'b1', organizationId: 'o1', workspaceId: 'w1', status: 'DRAFT', parentBlastId: null, columns: ['Email Id', 'Name'], emailColumn: 'Email Id' };

beforeEach(() => {
  vi.clearAllMocks();
  session.viewingAs = null;
  db.recruiterBlast.findUnique.mockResolvedValue(blast);
  db.recruiterBlastRecipient.count.mockResolvedValue(5);
  db.$queryRaw.mockResolvedValue([]);
});

describe('POST items (add)', () => {
  it('adds valid new ones, reports duplicates and invalid ones', async () => {
    db.$queryRaw.mockResolvedValue([{ key: 'dup@acme.com' }]);
    const res = await call(POST, { rows: [{ email: 'New@acme.com', data: { Name: 'Neha' } }, { email: 'dup@acme.com' }, { email: 'bad' }] });
    const j = await res.json();
    expect(j).toMatchObject({ added: 1, duplicates: ['dup@acme.com'] });
    expect(j.invalid).toHaveLength(1);
    expect(db.recruiterBlastRecipient.create.mock.calls[0]![0].data).toMatchObject({ blastId: 'b1', email: 'new@acme.com', name: 'Neha', data: { 'Email Id': 'new@acme.com', Name: 'Neha' } });
  });
  it('only a draft; a follow-up cannot add', async () => {
    db.recruiterBlast.findUnique.mockResolvedValue({ ...blast, status: 'SENDING' });
    expect((await call(POST, { rows: [{ email: 'a@b.co' }] })).status).toBe(409);
    db.recruiterBlast.findUnique.mockResolvedValue({ ...blast, parentBlastId: 'p' });
    expect((await call(POST, { rows: [{ email: 'a@b.co' }] })).status).toBe(409);
    expect(db.recruiterBlastRecipient.create).not.toHaveBeenCalled();
  });
  it('is refused while viewing as someone', async () => {
    session.viewingAs = { userId: 'u2' };
    expect((await call(POST, { rows: [{ email: 'a@b.co' }] })).status).toBe(403);
  });
});

describe('PATCH items (edit)', () => {
  it('changes the cells and the address together', async () => {
    db.recruiterBlastRecipient.findFirst.mockResolvedValue({ id: 'r1', email: 'old@acme.com', name: 'Old', data: { 'Email Id': 'old@acme.com', Name: 'Old' }, status: 'PENDING' });
    db.recruiterBlastRecipient.update.mockResolvedValue({ id: 'r1', email: 'new@acme.com', name: 'New', status: 'PENDING', data: {} });
    const res = await call(PATCH, { id: 'r1', email: 'new@acme.com', data: { Name: 'New' } });
    expect(res.status).toBe(200);
    expect(db.recruiterBlastRecipient.update.mock.calls[0]![0].data).toMatchObject({ email: 'new@acme.com', name: 'New', data: { 'Email Id': 'new@acme.com', Name: 'New' } });
  });
  it('refuses an address already in the list (409) and a bad one (400)', async () => {
    db.recruiterBlastRecipient.findFirst.mockResolvedValue({ id: 'r1', email: 'old@acme.com', name: null, data: {}, status: 'PENDING' });
    db.$queryRaw.mockResolvedValue([{ key: 'taken@acme.com' }]);
    expect((await call(PATCH, { id: 'r1', email: 'taken@acme.com' })).status).toBe(409);
    expect((await call(PATCH, { id: 'r1', email: 'nope' })).status).toBe(400);
    expect(db.recruiterBlastRecipient.update).not.toHaveBeenCalled();
  });
  it('404 for a row that is gone', async () => {
    db.recruiterBlastRecipient.findFirst.mockResolvedValue(null);
    expect((await call(PATCH, { id: 'zz', email: 'a@b.co' })).status).toBe(404);
  });
});

describe('DELETE items', () => {
  it('deletes the ticked rows and hands them back for undo', async () => {
    db.recruiterBlastRecipient.count.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    db.recruiterBlastRecipient.findMany.mockResolvedValue([{ email: 'a@x.com', name: null, data: { 'Email Id': 'a@x.com' } }, { email: 'b@x.com', name: null, data: null }]);
    db.recruiterBlastRecipient.deleteMany.mockResolvedValue({ count: 2 });
    const j = await (await call(DELETE, { ids: ['r1', 'r2'] })).json();
    expect(j).toMatchObject({ deleted: 2, remaining: 3 });
    expect(j.undo).toHaveLength(2);
    expect(db.recruiterBlastRecipient.deleteMany.mock.calls[0]![0].where).toEqual({ blastId: 'b1', id: { in: ['r1', 'r2'] } });
  });
  it('"all matching" uses the search and the domains on the server', async () => {
    db.recruiterBlastRecipient.count.mockResolvedValueOnce(7).mockResolvedValueOnce(0);
    db.recruiterBlastRecipient.findMany.mockResolvedValue([]);
    db.recruiterBlastRecipient.deleteMany.mockResolvedValue({ count: 7 });
    await call(DELETE, { all: true, q: 'ravi', domains: ['@Microsoft.com', 'junk'] });
    expect(db.recruiterBlastRecipient.deleteMany.mock.calls[0]![0].where).toEqual({
      blastId: 'b1',
      AND: [
        { OR: [{ email: { contains: 'ravi', mode: 'insensitive' } }, { name: { contains: 'ravi', mode: 'insensitive' } }] },
        { OR: [{ email: { endsWith: '@microsoft.com', mode: 'insensitive' } }] },
      ],
    });
  });
  it('a follow-up draft can delete; a started send cannot', async () => {
    db.recruiterBlast.findUnique.mockResolvedValue({ ...blast, parentBlastId: 'p' });
    db.recruiterBlastRecipient.count.mockResolvedValue(0);
    expect((await call(DELETE, { ids: ['r1'] })).status).toBe(200);
    db.recruiterBlast.findUnique.mockResolvedValue({ ...blast, status: 'COMPLETED' });
    expect((await call(DELETE, { ids: ['r1'] })).status).toBe(409);
  });
});
