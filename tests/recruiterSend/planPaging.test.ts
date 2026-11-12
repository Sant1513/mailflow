import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pre-send check works out the whole plan but returns the recruiter and batch tables one
 * page at a time (filtered, searched, or one batch's recruiters), so lists of 20,000 never
 * reach the browser whole, yet every recruiter can be paged to.
 */
const db = {
  recruiterBlastRecipient: { findMany: vi.fn(), findFirst: vi.fn(async () => null) },
  emailProviderAccount: { findMany: vi.fn() },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/queue/drain', () => ({
  dailyLimit: () => 2000,
  DAILY_UNIQUE_RECIPIENT_LIMIT: 1_000_000,
  usageLast24h: vi.fn(async () => ({ messages: 0, totalRecipients: 0, unique: new Set() })),
}));
const problems = new Map<string, { kind: string; detail: string }>();
vi.mock('@/lib/email/addressCheck', () => ({ checkAddresses: vi.fn(async () => problems) }));

const session = { userId: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'ADMIN' };
const loadBlast = vi.fn();
vi.mock('@/lib/recruiterSend/access', () => ({ requireBlastReader: vi.fn(async () => session), loadBlast }));

const { planBlast, PEOPLE_PAGE_SIZE, planPageSchema } = await import('@/lib/recruiterSend/plan');
const check = await import('@/app/api/recruiter-blasts/[id]/check/route');
const peopleRoute = await import('@/app/api/recruiter-blasts/[id]/check/people/route');

const blast = { id: 'b1', organizationId: 'o1', workspaceId: 'w1', mode: 'BCC', sendOrder: 'PARALLEL', groupSize: 250, gapSeconds: 60, accountIds: ['a1'], accountLimits: {}, subject: 'Hello', html: '<p>Hi</p>', plainText: 'Hi', body: 'Hi', columns: [], emailColumn: null };
const recipients = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}`, email: `r${i}@corp.com`, name: i % 2 ? `Name ${i}` : null, data: null }));

beforeEach(() => {
  vi.clearAllMocks();
  problems.clear();
  db.emailProviderAccount.findMany.mockResolvedValue([{ id: 'a1', emailAddress: 'one@x.com', status: 'CONNECTED' }]);
  db.recruiterBlastRecipient.findMany.mockResolvedValue(recipients(3001));
  loadBlast.mockResolvedValue(blast);
});

describe('planBlast paging', () => {
  it('a 3,001-recruiter plan returns 50 rows and 61 pages, but plans and sends everyone', async () => {
    const plan = await planBlast(blast);
    expect(PEOPLE_PAGE_SIZE).toBe(50);
    expect(plan.people).toHaveLength(50);
    expect(plan).toMatchObject({ total: 3001, peopleTotal: 3001, peoplePage: 1, peoplePages: 61, peoplePageSize: 50, peopleFilter: 'all', batch: null, q: '' });
    expect(plan.people[0]).toEqual({ email: 'r0@corp.com', name: null, batch: 1, batchSize: 250, round: 1, mailbox: 'one@x.com', skipped: null });
    expect(plan.eligibleIds).toHaveLength(3001);
    expect(plan.messages).toBe(13);
    expect(plan.batchesTotal).toBe(13);
    expect(plan.batches).toHaveLength(13);
    expect(plan.batchFirst[1]).toBe('r0@corp.com');
    expect(plan.batchFirst[13]).toBe('r3000@corp.com');
    expect(plan.byMailbox).toEqual([{ mailbox: 'one@x.com', emails: 13, recruiters: 3001 }]);
    expect(plan.batchesLater).toBe(0);
  });

  it('returns the last page (one recruiter), and keeps a page past the end on the last page', async () => {
    const last = await planBlast(blast, { peoplePage: 61 });
    expect(last.people.map((p) => p.email)).toEqual(['r3000@corp.com']);
    expect(last.peoplePage).toBe(61);
    const past = await planBlast(blast, { peoplePage: 999 });
    expect(past.peoplePage).toBe(61);
    expect(past.people).toHaveLength(1);
    const mid = await planBlast(blast, { peoplePage: 2 });
    expect(mid.people[0]!.email).toBe('r50@corp.com');
    expect(mid.people.at(-1)!.email).toBe('r99@corp.com');
  });

  it('honours a custom page size', async () => {
    const plan = await planBlast(blast, { peoplePageSize: 1000, peoplePage: 4 });
    expect(plan.peoplePages).toBe(4);
    expect(plan.people).toHaveLength(1);
  });

  it('filters skipped / will get it, one batch, and searches email and name', async () => {
    db.recruiterBlastRecipient.findMany.mockResolvedValue(recipients(120));
    for (let i = 0; i < 120; i += 10) problems.set(`r${i}@corp.com`, { kind: 'SUPPRESSED', detail: 'unsubscribed' });
    const small = { ...blast, groupSize: 50 };

    const skipped = await planBlast(small, { peopleFilter: 'skipped' });
    expect(skipped.peopleTotal).toBe(12);
    expect(skipped.people.every((p) => p.skipped === 'unsubscribed' && p.batch === null)).toBe(true);
    expect(skipped.total).toBe(120);
    expect(skipped.skippedByReason).toEqual({ SUPPRESSED: 12 });

    const sending = await planBlast(small, { peopleFilter: 'sending' });
    expect(sending.peopleTotal).toBe(108);
    expect(sending.peoplePages).toBe(3);
    expect(sending.people.every((p) => !p.skipped)).toBe(true);

    const batch2 = await planBlast(small, { batch: 2 });
    expect(batch2.peopleTotal).toBe(50);
    expect(batch2.people.every((p) => p.batch === 2)).toBe(true);
    expect(batch2.batch).toBe(2);
    const batch3Skipped = await planBlast(small, { batch: 3, peopleFilter: 'skipped' });
    expect(batch3Skipped.peopleTotal).toBe(0);
    expect(batch3Skipped.people).toEqual([]);
    expect(batch3Skipped.peoplePages).toBe(1);

    const byName = await planBlast(small, { q: '  NAME 11 ' });
    expect(byName.q).toBe('NAME 11');
    expect(byName.people.map((p) => p.email)).toEqual(['r11@corp.com', 'r111@corp.com', 'r113@corp.com', 'r115@corp.com', 'r117@corp.com', 'r119@corp.com']);
    const byEmail = await planBlast(small, { q: 'r10' });
    expect(byEmail.people.map((p) => p.email)).toEqual(['r10@corp.com', 'r100@corp.com', 'r101@corp.com', 'r102@corp.com', 'r103@corp.com', 'r104@corp.com', 'r105@corp.com', 'r106@corp.com', 'r107@corp.com', 'r108@corp.com', 'r109@corp.com']);
  });

  it('pages the batch table 50 at a time with each batch\'s first recruiter', async () => {
    db.recruiterBlastRecipient.findMany.mockResolvedValue(recipients(120));
    const plan = await planBlast({ ...blast, mode: 'INDIVIDUAL' }, { batchPage: 3 });
    expect(plan.batchesTotal).toBe(120);
    expect(plan.batchPages).toBe(3);
    expect(plan.batchPage).toBe(3);
    expect(plan.batches.map((b) => b.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 101 + i));
    expect(Object.keys(plan.batchFirst).map(Number)).toEqual(Array.from({ length: 20 }, (_, i) => 101 + i));
    expect(plan.batchFirst[101]).toBe('r100@corp.com');
  });

  it('counts batches with no room today over every batch, not just the page shown', async () => {
    db.recruiterBlastRecipient.findMany.mockResolvedValue(recipients(120));
    const plan = await planBlast({ ...blast, mode: 'INDIVIDUAL', accountLimits: { a1: 100 } });
    expect(plan.batchesLater).toBe(20);
    expect(plan.byMailbox).toEqual([{ mailbox: 'one@x.com', emails: 100, recruiters: 100 }, { mailbox: null, emails: 20, recruiters: 20 }]);
    expect(plan.batches).toHaveLength(50);
    expect(plan.plannedAccountIds).toHaveLength(120);
  });
});

describe('check body', () => {
  it('accepts an empty body and the paging fields', () => {
    expect(planPageSchema.parse({})).toEqual({});
    expect(planPageSchema.parse({ peoplePage: 3, peopleFilter: 'skipped', batch: null, q: 'acme', batchPage: 2 })).toMatchObject({ peoplePage: 3, batch: null });
  });
  it('rejects bad pages, filters and batches', () => {
    for (const bad of [{ peoplePage: 0 }, { peoplePage: 1.5 }, { peoplePage: '2' }, { peopleFilter: 'everyone' }, { batch: 0 }, { batchPage: -1 }, { q: 'x'.repeat(201) }]) {
      expect(planPageSchema.safeParse(bad).success).toBe(false);
    }
  });
});

const post = (route: typeof check, body?: unknown, id = 'b1') =>
  route.POST(new Request(`http://localhost/api/recruiter-blasts/${id}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) as any, { params: { id } } as any);

describe('POST /api/recruiter-blasts/[id]/check', () => {
  it('returns the first page by default, with the preview and without ids', async () => {
    const res = await post(check);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ total: 3001, eligible: 3001, peoplePage: 1, peoplePages: 61, peopleTotal: 3001, batchesTotal: 13 });
    expect(j.people).toHaveLength(50);
    expect(typeof j.preview).toBe('string');
    expect(j).not.toHaveProperty('eligibleIds');
    expect(j).not.toHaveProperty('skippedReasons');
  });

  it('takes a page, filter and search from the body', async () => {
    const j = await (await post(check, { peoplePage: 61 })).json();
    expect(j.peoplePage).toBe(61);
    expect(j.people.map((p: { email: string }) => p.email)).toEqual(['r3000@corp.com']);
  });

  it('400s on a bad body', async () => {
    expect((await post(check, { peoplePage: 0 })).status).toBe(400);
    expect((await post(check, { peopleFilter: 'nobody' })).status).toBe(400);
  });

  it('404s for a send that does not exist', async () => {
    loadBlast.mockResolvedValue(null);
    expect((await post(check)).status).toBe(404);
  });
});

describe('POST /api/recruiter-blasts/[id]/check/people', () => {
  it('returns only the table page fields (no preview)', async () => {
    const res = await post(peopleRoute, { peoplePage: 2, batchPage: 1 });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ peoplePage: 2, peoplePages: 61, peopleTotal: 3001, total: 3001, batchesTotal: 13, batchPage: 1, batchPages: 1 });
    expect(j.people[0].email).toBe('r50@corp.com');
    expect(j.batchFirst['1']).toBe('r0@corp.com');
    for (const k of ['preview', 'eligible', 'capacity', 'skipped', 'personalization']) expect(j).not.toHaveProperty(k);
  });

  it('validates the body and checks access the same way', async () => {
    expect((await post(peopleRoute, { batch: 'two' })).status).toBe(400);
    loadBlast.mockResolvedValue(null);
    expect((await post(peopleRoute, {})).status).toBe(404);
  });
});
