import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "Preview list" table pages through a send's recruiters 50 at a time with every uploaded
 * column, and searches email and name, without loading the whole list into the page.
 */
const db = {
  recruiterBlast: { findUnique: vi.fn() },
  recruiterBlastRecipient: { count: vi.fn(), findMany: vi.fn() },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/campaigns/fallback', () => ({ availableFallbackMailboxes: vi.fn(), ownMailbox: vi.fn() }));

const session: Record<string, unknown> = { userId: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'ADMIN', viewingAs: null };
vi.mock('@/lib/auth/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...real, requireRole: vi.fn(async () => session) };
});

const { GET } = await import('@/app/api/recruiter-blasts/[id]/recipients/route');
const get = (query = '', id = 'b1') => GET(new Request(`http://localhost/api/recruiter-blasts/${id}/recipients${query}`) as any, { params: { id } } as any);

const blast = { id: 'b1', organizationId: 'o1', workspaceId: 'w1', status: 'DRAFT', columns: ['Email Id', 'Name', 'Link'], emailColumn: 'Email Id' };

beforeEach(() => {
  vi.clearAllMocks();
  session.viewingAs = null;
  db.recruiterBlast.findUnique.mockResolvedValue(blast);
  db.recruiterBlastRecipient.count.mockResolvedValue(120);
  db.recruiterBlastRecipient.findMany.mockResolvedValue([
    { email: 'a@acme.com', name: 'Asha', status: 'PENDING', data: { 'Email Id': 'a@acme.com', Name: 'Asha', Link: 'https://x.y/?a' } },
    { email: 'b@corp.in', name: null, status: 'PENDING', data: null },
  ]);
});

describe('GET /api/recruiter-blasts/[id]/recipients', () => {
  it('returns the first page of 50 with the columns, total and every row\'s data', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ columns: blast.columns, emailColumn: 'Email Id', status: 'DRAFT', page: 1, perPage: 50, pages: 3, total: 120, q: '' });
    expect(j.recipients).toEqual([
      { email: 'a@acme.com', name: 'Asha', status: 'PENDING', data: { 'Email Id': 'a@acme.com', Name: 'Asha', Link: 'https://x.y/?a' } },
      { email: 'b@corp.in', name: null, status: 'PENDING', data: {} },
    ]);
    const args = db.recruiterBlastRecipient.findMany.mock.calls[0]![0];
    expect(args).toMatchObject({ where: { blastId: 'b1' }, skip: 0, take: 50, select: { email: true, name: true, status: true, data: true } });
    expect(args.where).not.toHaveProperty('OR');
  });

  it('pages with ?page= and searches email and name with ?q=', async () => {
    const j = await (await get('?page=3&q=%20Acme%20')).json();
    expect(j.page).toBe(3);
    expect(j.q).toBe('Acme');
    const args = db.recruiterBlastRecipient.findMany.mock.calls[0]![0];
    expect(args.skip).toBe(100);
    expect(args.where).toEqual({
      blastId: 'b1',
      OR: [{ email: { contains: 'Acme', mode: 'insensitive' } }, { name: { contains: 'Acme', mode: 'insensitive' } }],
    });
    // The total counts the same search.
    expect(db.recruiterBlastRecipient.count.mock.calls[0]![0].where).toEqual(args.where);
  });

  it('treats a bad page number as page 1', async () => {
    const j = await (await get('?page=abc')).json();
    expect(j.page).toBe(1);
    expect(db.recruiterBlastRecipient.findMany.mock.calls[0]![0].skip).toBe(0);
    expect((await (await get('?page=-4')).json()).page).toBe(1);
  });

  it('is readable while a Super Admin views as someone (read-only)', async () => {
    session.viewingAs = { userId: 'u2' };
    expect((await get()).status).toBe(200);
  });

  it('404s for a send that does not exist', async () => {
    db.recruiterBlast.findUnique.mockResolvedValue(null);
    expect((await get('', 'missing')).status).toBe(404);
    expect(db.recruiterBlastRecipient.findMany).not.toHaveBeenCalled();
  });

  it("refuses another workspace's send to an ADMIN", async () => {
    db.recruiterBlast.findUnique.mockResolvedValue({ ...blast, workspaceId: 'other' });
    expect((await get()).status).toBe(403);
    expect(db.recruiterBlastRecipient.findMany).not.toHaveBeenCalled();
  });

  it("refuses another organisation's send", async () => {
    db.recruiterBlast.findUnique.mockResolvedValue({ ...blast, organizationId: 'o2' });
    expect((await get()).status).toBe(403);
  });
});
