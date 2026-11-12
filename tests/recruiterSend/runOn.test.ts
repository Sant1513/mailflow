import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Send from the laptop" (RecruiterBlast.runOn): Vercel's sender skips laptop sends while the
 * laptop is alive, takes them over when it has been silent for 10 minutes, the laptop's runner
 * sends only laptop sends, and claims keep every message to one send across the hand-over.
 * A small in-memory database; nothing real is sent.
 */

interface B { id: string; organizationId: string; createdById: string; workspaceId: string; name: string; status: string; runOn: string; runOnChangedAt: Date | null; [k: string]: unknown }
interface G { id: string; blastId: string; seq: number; status: string; plannedAccountId: string | null; accountId: string | null; recipientCount: number; sentAt: Date | null; attempts: number; createdAt: Date }
const state = { blasts: [] as B[], groups: [] as G[], laptopSeen: null as Date | null };
const statusOk = (want: any, s: string) => (want === undefined ? true : typeof want === 'string' ? want === s : want.in.includes(s));
const runOnOk = (want: any, v: string) => (want === undefined ? true : typeof want === 'string' ? want === v : v !== want.not);
const blastMatch = (w: any = {}, b: B) =>
  (w.id === undefined || (typeof w.id === 'string' ? w.id === b.id : w.id.notIn ? !w.id.notIn.includes(b.id) : w.id.in.includes(b.id))) && statusOk(w.status, b.status) && runOnOk(w.runOn, b.runOn);

const db = {
  recruiterBlast: {
    findMany: vi.fn(async (q: any) => state.blasts.filter((b) => blastMatch(q.where, b))),
    findUnique: vi.fn(async (q: any) => state.blasts.find((b) => b.id === q.where.id) ?? null),
    count: vi.fn(async (q: any) => state.blasts.filter((b) => blastMatch(q.where, b)).length),
    updateMany: vi.fn(async (q: any) => {
      const hit = state.blasts.filter((b) => blastMatch(q.where, b) && (!q.where.scheduledAt || true));
      hit.forEach((b) => Object.assign(b, q.data));
      return { count: hit.length };
    }),
    update: vi.fn(async (q: any) => Object.assign(state.blasts.find((b) => b.id === q.where.id)!, q.data)),
  },
  recruiterBlastGroup: {
    findMany: vi.fn(async (q: any) => {
      if (q.where.createdAt) return []; // recoverStuck: nothing is old enough here
      return state.groups.filter((g) => g.blastId === q.where.blastId && statusOk(q.where.status, g.status)).sort((a, b) => a.seq - b.seq).map((g) => ({ ...g }));
    }),
    findFirst: vi.fn(async () => null),
    count: vi.fn(async (q: any) => state.groups.filter((g) => g.blastId === q.where.blastId && statusOk(q.where.status, g.status)).length),
    groupBy: vi.fn(async (q: any) => {
      const rows = state.groups.filter((g) => g.blastId === q.where.blastId && statusOk(q.where.status, g.status) && g.accountId && (!q.where.sentAt || g.sentAt));
      const by = new Map<string, G[]>();
      for (const g of rows) by.set(g.accountId!, [...(by.get(g.accountId!) ?? []), g]);
      return [...by].map(([accountId, gs]) =>
        q._sum ? { accountId, _sum: { recipientCount: gs.reduce((n, g) => n + g.recipientCount, 0) } } : { accountId, _max: { sentAt: new Date(Math.max(...gs.map((g) => g.sentAt!.getTime()))) } },
      );
    }),
    updateMany: vi.fn(async (q: any) => {
      if (typeof q.where.id === 'string') {
        const g = state.groups.find((x) => x.id === q.where.id)!;
        if (g.status !== q.where.status) return { count: 0 };
        if (q.data.status === 'SENDING') {
          // The claim: only while the send is SENDING, runs where this run sends from, and the mailbox is free.
          const b = state.blasts.find((x) => x.id === g.blastId)!;
          const w = q.where.blast;
          if (b.status !== w.status || !runOnOk(w.runOn, b.runOn)) return { count: 0 };
          const none = w.groups.none;
          if (state.groups.some((x) => x.blastId === g.blastId && x.status === 'SENDING' && (!none.accountId || x.accountId === none.accountId))) return { count: 0 };
          Object.assign(g, { status: 'SENDING', sentAt: q.data.sentAt, accountId: q.data.accountId, attempts: g.attempts + 1 });
        }
        return { count: 1 };
      }
      const ids: string[] = q.where.id?.in ?? [];
      for (const g of state.groups) if (ids.includes(g.id) && q.data.plannedAccountId !== undefined) g.plannedAccountId = q.data.plannedAccountId;
      return { count: ids.length };
    }),
    update: vi.fn(async (q: any) => Object.assign(state.groups.find((g) => g.id === q.where.id)!, q.data)),
  },
  recruiterBlastRecipient: {
    findMany: vi.fn(async (q: any) => [{ id: `r-${q.where.groupId}`, email: `${q.where.groupId}@corp.com`, name: null, data: null }]),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  emailProviderAccount: { findUnique: vi.fn(async (q: any) => ({ id: q.where.id, emailAddress: `${q.where.id}@masaischool.com`, displayName: null, status: 'CONNECTED', refreshTokenEnc: 'x' })), update: vi.fn() },
  documentTemplate: { findMany: vi.fn(async () => []) },
  emailSuppression: { findMany: vi.fn(async () => []) },
  systemState: { findUnique: vi.fn(async () => ({ id: 'main', activeServer: 'cloud', switchTo: null, switchStartedAt: null, lastSyncAt: null, lastLaptopSeenAt: state.laptopSeen, updatedAt: new Date() })), upsert: vi.fn() },
  auditLog: { create: vi.fn(async () => ({})) },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@/lib/queue/drain', () => ({
  backoffUntil: vi.fn(async () => 0),
  usageLast24h: vi.fn(async () => ({ messages: 0, totalRecipients: 0, unique: new Set() })),
  wouldExceedDaily: vi.fn(() => false),
}));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));
vi.mock('@/lib/recruiterSend/access', () => ({ allowedMailboxIds: vi.fn(async () => new Set(['a1', 'a2'])) }));
vi.mock('@/lib/recruiterSend/replies', () => ({ suppressRejectedRecruiter: vi.fn(), markRecruiterBounced: vi.fn() }));
vi.mock('@/lib/storage/files', () => ({ readRef: vi.fn(), BUCKET: 'b', storageEnabled: () => false }));

const { runRecruiterWorker, takeOverSilentLaptopSends, nudgeStuckSends } = await import('@/lib/recruiterSend/worker');

const sent: { blast: string; group: string; from: string }[] = [];
const send = async (account: any, input: any) => {
  sent.push({ blast: input.to.split('@')[0].startsWith('g') ? state.groups.find((g) => `${g.id}@corp.com` === input.to)!.blastId : '?', group: input.to.split('@')[0], from: account.emailAddress });
  return { providerMessageId: `m${sent.length}`, threadId: 't', messageIdHeader: '<x>' };
};
const run = (runOn?: 'cloud' | 'laptop' | 'all') => runRecruiterWorker({ budgetMs: 45_000, send, runOn, staggerMs: () => 0, sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); } });

function blast(id: string, runOn: 'cloud' | 'laptop', groups: number, account = 'a1'): void {
  state.blasts.push({
    id, organizationId: 'o1', createdById: 'u1', workspaceId: 'w1', name: `Send ${id}`, mode: 'INDIVIDUAL', sendOrder: 'PARALLEL', status: 'SENDING', toAddress: null,
    subject: 'Hi', html: '<p>Hi</p>', plainText: 'Hi', fromName: null, replyTo: null, ccAddresses: [], accountIds: [account], accountLimits: {}, video: null,
    attachmentDocumentIds: [], gapSeconds: 0, note: null, startedAt: new Date(), runOn, runOnChangedAt: null,
  });
  for (let i = 1; i <= groups; i++) state.groups.push({ id: `g${id}${i}`, blastId: id, seq: i, status: 'PENDING', plannedAccountId: account, accountId: null, recipientCount: 1, sentAt: null, attempts: 0, createdAt: new Date() });
}
const fetchMock = vi.fn(async () => new Response('{}'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  process.env.CRON_SECRET = 'test-secret';
  delete process.env.MAILFLOW_SERVER;
  state.blasts = [];
  state.groups = [];
  sent.length = 0;
});

describe('cloud sender and laptop sends', () => {
  it('skips a laptop send while the laptop is alive (and never hands over for it)', async () => {
    state.laptopSeen = new Date(Date.now() - 30_000);
    blast('L', 'laptop', 2);
    blast('C', 'cloud', 1, 'a2');
    const r = await run();
    expect(r.sent).toBe(1);
    expect(sent.map((s) => s.blast)).toEqual(['C']);
    expect(state.groups.filter((g) => g.blastId === 'L').every((g) => g.status === 'PENDING')).toBe(true);
    expect(state.blasts.find((b) => b.id === 'L')!.runOn).toBe('laptop');
    expect(fetchMock).not.toHaveBeenCalled(); // nothing left for the cloud: no Vercel hand-over
  });

  it('takes a laptop send over when the laptop has been silent for more than 10 minutes', async () => {
    state.laptopSeen = new Date(Date.now() - 11 * 60_000);
    blast('L', 'laptop', 2);
    const r = await run();
    const b = state.blasts[0]!;
    expect(b.runOn).toBe('cloud');
    expect(b.runOnChangedAt).toBeInstanceOf(Date);
    expect(r.sent).toBe(2);
    expect(b.status).toBe('COMPLETED');
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'RECRUITER_SEND_MOVED_TO_CLOUD', targetId: 'L' }) }));
  });

  it('a laptop that never reported counts as silent; 9 minutes is not', async () => {
    blast('L', 'laptop', 1);
    state.laptopSeen = new Date(Date.now() - 9 * 60_000);
    expect(await takeOverSilentLaptopSends()).toEqual([]);
    state.laptopSeen = null;
    expect(await takeOverSilentLaptopSends()).toEqual(['L']);
    expect(await takeOverSilentLaptopSends()).toEqual([]); // moved once only
  });

  it('costs one count and no state read when nothing runs on the laptop', async () => {
    blast('C', 'cloud', 1);
    expect(await takeOverSilentLaptopSends()).toEqual([]);
    expect(db.systemState.findUnique).not.toHaveBeenCalled();
  });

  it('the page watchdog does not restart Vercel for a laptop send', async () => {
    state.laptopSeen = new Date();
    blast('L', 'laptop', 1);
    state.blasts[0]!.startedAt = new Date(Date.now() - 3_600_000); // long quiet: would count as stuck
    expect(await nudgeStuckSends('test')).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the laptop runner (runOn: laptop)', () => {
  it('sends laptop sends only and never calls Vercel', async () => {
    state.laptopSeen = new Date();
    blast('L', 'laptop', 2);
    blast('C', 'cloud', 1, 'a2');
    const r = await run('laptop');
    expect(r.sent).toBe(2);
    expect(new Set(sent.map((s) => s.blast))).toEqual(new Set(['L']));
    expect(state.groups.find((g) => g.blastId === 'C')!.status).toBe('PENDING');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.systemState.findUnique).not.toHaveBeenCalled(); // the runner never takes anything over
  });

  it('the laptop as active server (MAILFLOW_SERVER=laptop) sends everything', async () => {
    process.env.MAILFLOW_SERVER = 'laptop';
    state.laptopSeen = new Date();
    blast('L', 'laptop', 1);
    blast('C', 'cloud', 1, 'a2');
    const r = await runRecruiterWorker({ budgetMs: 45_000, send, staggerMs: () => 0, sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); } });
    expect(r.sent).toBe(2);
  });

  it('stops between messages when asked', async () => {
    state.laptopSeen = new Date();
    blast('L', 'laptop', 3);
    const r = await runRecruiterWorker({ budgetMs: 45_000, send, runOn: 'laptop', stop: () => true, staggerMs: () => 0 });
    expect(r.sent).toBe(0);
  });
});

describe('no double send across the hand-over', () => {
  it('a message the laptop claimed is never sent by the cloud; the laptop claims nothing after the move', async () => {
    blast('L', 'laptop', 3);
    // The laptop had claimed g1 (in flight) when it went silent.
    Object.assign(state.groups[0]!, { status: 'SENDING', accountId: 'a1', sentAt: new Date(), attempts: 1 });
    state.laptopSeen = new Date(Date.now() - 15 * 60_000);
    await run();
    expect(state.blasts[0]!.runOn).toBe('cloud');
    expect(sent.map((s) => s.group)).not.toContain('gL1');
    expect(state.groups[0]!.status).toBe('SENDING'); // left to recoverStuck ("check the Sent folder"), never re-sent

    // The laptop comes back mid-run: its claims fail now that the send belongs to the cloud.
    state.groups[0]!.status = 'FAILED';
    state.groups.push({ id: 'gL4', blastId: 'L', seq: 4, status: 'PENDING', plannedAccountId: 'a1', accountId: null, recipientCount: 1, sentAt: null, attempts: 0, createdAt: new Date() });
    state.blasts[0]!.status = 'SENDING';
    const before = sent.length;
    const all = state.blasts[0]!;
    // Bypass the runner's own filter: hand the laptop run the blast directly, as if read just before the move.
    db.recruiterBlast.findMany.mockImplementationOnce(async () => [all]);
    await run('laptop');
    expect(sent.length).toBe(before);
    expect(state.groups.find((g) => g.id === 'gL4')!.status).toBe('PENDING');
  });

  it('each message goes out once when the laptop and the cloud both run', async () => {
    state.laptopSeen = new Date(Date.now() - 11 * 60_000);
    blast('L', 'laptop', 4);
    await Promise.all([run('laptop'), run()]);
    const groups = sent.map((s) => s.group);
    expect(new Set(groups).size).toBe(groups.length);
  });
});
