import { beforeEach, describe, expect, it, vi } from 'vitest';

/** POST /api/recruiter-blasts/[id]/start with runOn: who may send from the laptop, and what is stored. */

const stored: Record<string, unknown>[] = [];
const tx = {
  recruiterBlastRecipient: { update: vi.fn() },
  recruiterBlastGroup: { createManyAndReturn: vi.fn(async () => [{ id: 'g1', seq: 1 }]) },
  $executeRaw: vi.fn(async () => 1),
  recruiterBlast: { update: vi.fn(async (q: any) => { stored.push(q.data); return q.data; }) },
};
const db = {
  emailProviderAccount: { count: vi.fn(async () => 1) },
  documentTemplate: { findMany: vi.fn(async () => []) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/audit/log', () => ({ audit: vi.fn(async () => undefined) }));
const draft = {
  id: 'b1', organizationId: 'o1', workspaceId: 'w1', createdById: 'u1', status: 'DRAFT', mode: 'INDIVIDUAL', toAddress: null, subject: 'Hi', body: 'Hello', html: '<p>Hello</p>', plainText: 'Hello',
  columns: [], ccAddresses: [], accountIds: ['a1'], attachmentDocumentIds: [], video: null, groupSize: 250,
};
vi.mock('@/lib/recruiterSend/access', () => ({
  requireBlastAdmin: vi.fn(async () => ({ userId: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'ADMIN' })),
  loadBlast: vi.fn(async () => ({ ...draft })),
  allowedMailboxIds: vi.fn(async () => new Set(['a1'])),
}));
vi.mock('@/lib/recruiterSend/plan', () => ({
  planBlast: vi.fn(async () => ({ eligibleIds: ['r1'], skippedReasons: new Map(), plannedAccountIds: ['a1'], sendOrder: 'PARALLEL', rounds: 1 })),
}));
const kick = vi.fn();
vi.mock('@/lib/recruiterSend/worker', () => ({ kickRecruiterWorker: kick }));
const server = { activeServer: 'cloud', lastLaptopSeenAt: null as Date | null };
vi.mock('@/lib/system/serverState', async (orig) => ({
  ...(await orig<typeof import('@/lib/system/serverState')>()),
  currentState: vi.fn(async () => ({ id: 'main', switchTo: null, ...server })),
}));

const { POST } = await import('@/app/api/recruiter-blasts/[id]/start/route');
const start = (body: unknown) => POST(new Request('http://mailflow.test/api/recruiter-blasts/b1/start', { method: 'POST', body: JSON.stringify(body) }), { params: { id: 'b1' } });

beforeEach(() => {
  vi.clearAllMocks();
  stored.length = 0;
  Object.assign(server, { activeServer: 'cloud', lastLaptopSeenAt: null });
});

describe('start: send from', () => {
  it('cloud by default, started on Vercel at once', async () => {
    const res = await start({});
    expect(res.status).toBe(200);
    expect((await res.json()).runOn).toBe('cloud');
    expect(stored[0]).toMatchObject({ runOn: 'cloud', status: 'SENDING' });
    expect(kick).toHaveBeenCalledWith('start');
  });

  it('laptop offline → 409 with the reason, nothing started', async () => {
    server.lastLaptopSeenAt = new Date(Date.now() - 5 * 60_000);
    const res = await start({ runOn: 'laptop' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/laptop is offline/i);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it('laptop online → stored as a laptop send, no Vercel run', async () => {
    server.lastLaptopSeenAt = new Date(Date.now() - 20_000);
    const res = await start({ runOn: 'laptop' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runOn: 'laptop', alreadyOnLaptop: false });
    expect(stored[0]).toMatchObject({ runOn: 'laptop', runOnChangedAt: null });
    expect(kick).not.toHaveBeenCalled();
  });

  it('MailFlow already on the laptop → runs there as an ordinary send', async () => {
    Object.assign(server, { activeServer: 'laptop', lastLaptopSeenAt: new Date() });
    const res = await start({ runOn: 'laptop' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runOn: 'cloud', alreadyOnLaptop: true });
    expect(stored[0]).toMatchObject({ runOn: 'cloud' });
  });

  it('rejects anything but cloud or laptop', async () => {
    const res = await start({ runOn: 'moon' });
    expect(res.status).toBe(400);
  });
});
