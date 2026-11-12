import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Suppressions page API: server-side filters from the URL (type, category, source, scope, IST
 * date range, search across email / remark / server message / code, the send it came from),
 * sort, paging, and the CSV download of the filtered list. Writes still need a writer.
 */
const rows = [
  {
    id: 's1',
    email: 'jannat.t@healthfab.in',
    reason: 'BOUNCED',
    source: 'BOUNCE',
    detail: '452 4.7.1 Mailbox delivery restricted by policy error',
    category: 'POLICY_BLOCK',
    statusCode: '4.7.1',
    remark: "Blocked by the recipient's mail policy · Bounce notice (Recruiter Bulk Send “Set 2”)",
    recruiterBlastId: 'blast-1',
    createdAt: new Date('2026-11-09T11:12:44Z'),
    addedBy: null,
    campaign: null,
  },
];
const db = {
  emailSuppression: {
    findMany: vi.fn(async (_q: any) => rows),
    count: vi.fn(async (_q: any) => 1),
    groupBy: vi.fn(async ({ by }: any) => (by[0] === 'recruiterBlastId' ? [{ recruiterBlastId: 'blast-1', _count: { _all: 1 } }] : [])),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  campaign: { findMany: vi.fn(async () => []) },
  recruiterBlast: { findMany: vi.fn(async () => [{ id: 'blast-1', name: 'Recruiter send For Drive · 5 Nov 2026 Set 2' }]) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const session = { userId: 'u1', organizationId: 'org1', workspaceId: 'w1', role: 'OPERATOR' as string, viewingAs: null as any };
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig<any>()), requireSession: vi.fn(async () => session) }));

const { GET, DELETE } = await import('@/app/api/suppressions/route');
const call = (qs: string) => GET(new Request(`http://localhost/api/suppressions?${qs}`), {});
const whereOf = () => db.emailSuppression.findMany.mock.calls[0]![0].where.AND as any[];

beforeEach(() => {
  vi.clearAllMocks();
  session.role = 'OPERATOR';
});

describe('GET /api/suppressions filters', () => {
  it('lists with paging, the total, and the sends on the list', async () => {
    const res = await call('page=2&pageSize=25');
    const json = await res.json();
    expect(json).toMatchObject({ total: 1, page: 2, pageSize: 25, pages: 1 });
    expect(db.emailSuppression.findMany.mock.calls[0]![0]).toMatchObject({ skip: 25, take: 25, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    expect(json.suppressions[0]).toMatchObject({ category: 'POLICY_BLOCK', statusCode: '4.7.1', recruiterBlast: { id: 'blast-1', name: 'Recruiter send For Drive · 5 Nov 2026 Set 2' }, orgCopy: false });
    expect(json.sends).toEqual([{ value: 'blast:blast-1', label: 'Recruiter send · Recruiter send For Drive · 5 Nov 2026 Set 2', count: 1 }]);
    expect(whereOf()).toEqual([{ workspaceId: 'w1' }]);
  });

  it('applies type, category, source, scope, IST dates, search, send and sort on the server', async () => {
    await call('type=policy&category=POLICY_BLOCK&source=BOUNCE&scope=org&from=2026-11-01&to=2026-11-09&q=4.7.1&send=blast:blast-1&sort=email');
    const and = whereOf();
    expect(and).toContainEqual({ category: 'POLICY_BLOCK' });
    expect(and).toContainEqual({ source: 'BOUNCE' });
    expect(and).toContainEqual({ recruiterBlastId: 'blast-1' });
    expect(and).toContainEqual({ OR: [{ detail: { contains: "bounced on a teammate's send" } }, { detail: { contains: 'known across the organisation' } }] });
    expect(and).toContainEqual({ createdAt: { gte: new Date('2026-10-31T18:30:00.000Z'), lte: new Date('2026-11-09T18:29:59.999Z') } });
    const search = and.find((c) => c.OR?.some((o: any) => o.email))!;
    expect(search.OR.map((o: any) => Object.keys(o)[0])).toEqual(['email', 'detail', 'remark', 'statusCode']);
    expect(db.emailSuppression.findMany.mock.calls[0]![0].orderBy).toEqual([{ email: 'asc' }, { id: 'asc' }]);
  });

  it('type shortcuts and "no category"; unknown values are ignored', async () => {
    await call('type=unsubscribed&category=NONE&source=EVIL&from=yesterday');
    const and = whereOf();
    expect(and).toContainEqual({ reason: 'UNSUBSCRIBED' });
    expect(and).toContainEqual({ category: null });
    expect(and).toHaveLength(3);
    vi.clearAllMocks();
    await call('type=hard&scope=own&send=campaign:c1');
    const and2 = whereOf();
    expect(and2).toContainEqual({ reason: 'BOUNCED', category: { in: ['USER_UNKNOWN', 'DOMAIN_NOT_FOUND', 'MAILBOX_DISABLED', 'OTHER_HARD'] } });
    expect(and2).toContainEqual({ campaignId: 'c1' });
    expect(and2.some((c) => c.NOT)).toBe(true);
  });

  it('downloads the filtered list as CSV', async () => {
    const res = await call('type=policy&format=csv');
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="Suppressions \d{4}-\d{2}-\d{2} - 1 addresses\.csv"/);
    const body = await res.text();
    expect(body).toContain('"Email","Reason","Category","Remark","Status code"');
    expect(body).toContain('"jannat.t@healthfab.in","Bounced","Blocked by policy"');
    expect(body).toContain('"Recruiter send For Drive · 5 Nov 2026 Set 2"');
    expect(db.emailSuppression.findMany.mock.calls[0]![0]).toMatchObject({ take: 50000 });
    expect(whereOf()).toContainEqual({ category: 'POLICY_BLOCK' });
  });

  it('removing an entry still needs a writer', async () => {
    session.role = 'VIEWER';
    const res = await DELETE(new Request('http://localhost/api/suppressions?id=s1', { method: 'DELETE' }), {});
    expect(res.status).toBe(403);
    expect(db.emailSuppression.deleteMany).not.toHaveBeenCalled();
  });
});
