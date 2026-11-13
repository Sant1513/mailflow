import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PARALLEL recruiter sends against a small in-memory database: every mailbox sends its batch
 * together, each mailbox keeps its own pause, a mailbox that can't send hands its batches on,
 * and no more than MAX_PARALLEL messages are out at once. Nothing real is sent.
 */

interface G { id: string; blastId: string; seq: number; status: string; plannedAccountId: string | null; accountId: string | null; recipientCount: number; sentAt: Date | null; attempts: number; createdAt: Date }
const state = {
  blast: null as any,
  groups: [] as G[],
  accounts: new Map<string, any>(),
};
const statusOk = (want: any, s: string) => (want === undefined ? true : typeof want === 'string' ? want === s : want.in.includes(s));

const db = {
  recruiterBlast: {
    findMany: vi.fn(async () => (state.blast?.status === 'SENDING' ? [state.blast] : [])),
    findUnique: vi.fn(async () => ({ status: state.blast.status })),
    updateMany: vi.fn(async (q: any) => {
      if (q.where.status === 'SENDING' && state.blast.status === 'SENDING' && q.data.status) state.blast.status = q.data.status;
      return { count: 1 };
    }),
    update: vi.fn(async (q: any) => Object.assign(state.blast, q.data)),
    count: vi.fn(async () => 0),
  },
  recruiterBlastGroup: {
    findMany: vi.fn(async (q: any) => {
      if (q.where.createdAt) return []; // recoverStuck: nothing is stuck in these tests
      return state.groups.filter((g) => g.blastId === q.where.blastId && statusOk(q.where.status, g.status)).sort((a, b) => a.seq - b.seq).map((g) => ({ ...g }));
    }),
    findFirst: vi.fn(async () => null),
    count: vi.fn(async (q: any) => state.groups.filter((g) => statusOk(q.where.status, g.status)).length),
    groupBy: vi.fn(async (q: any) => {
      const rows = state.groups.filter((g) => statusOk(q.where.status, g.status) && g.accountId && (!q.where.sentAt || g.sentAt));
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
          const none = q.where.blast.groups.none;
          if (state.groups.some((x) => x.status === 'SENDING' && (!none.accountId || x.accountId === none.accountId))) return { count: 0 };
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
  emailProviderAccount: { findUnique: vi.fn(async (q: any) => state.accounts.get(q.where.id) ?? null), update: vi.fn() },
  documentTemplate: { findMany: vi.fn(async () => []) },
  emailSuppression: { findMany: vi.fn(async () => []) },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
const backoff = new Map<string, number>();
vi.mock('@/lib/queue/drain', () => ({
  backoffUntil: vi.fn(async (id: string) => backoff.get(id) ?? 0),
  usageLast24h: vi.fn(async () => ({ messages: 0, totalRecipients: 0, unique: new Set() })),
  wouldExceedDaily: vi.fn(() => false),
}));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));
const allowed = new Set<string>();
vi.mock('@/lib/recruiterSend/access', () => ({ allowedMailboxIds: vi.fn(async () => allowed) }));
vi.mock('@/lib/recruiterSend/replies', () => ({ suppressRejectedRecruiter: vi.fn(), markRecruiterBounced: vi.fn() }));
vi.mock('@/lib/storage/files', () => ({ readRef: vi.fn(), BUCKET: 'b', storageEnabled: () => false }));

const { runRecruiterWorker, MAX_PARALLEL } = await import('@/lib/recruiterSend/worker');
const { planMailboxes, estimateMinutes } = await import('@/lib/recruiterSend/plan');

const sent: { from: string; to: string; at: number }[] = [];
let inFlight = 0;
let maxInFlight = 0;
const send = async (account: any, input: any) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  sent.push({ from: account.emailAddress, to: input.to, at: Date.now() });
  await new Promise((r) => setTimeout(r, 5));
  inFlight--;
  return { providerMessageId: `m${sent.length}`, threadId: 't', messageIdHeader: '<x>' };
};
// The sender's waits move a fake clock instead of taking real time.
const run = () => runRecruiterWorker({ budgetMs: 45_000, send, staggerMs: () => 0, sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); } });

function setup(mailboxes: string[], planned: (string | null)[], over: Record<string, unknown> = {}) {
  state.accounts = new Map(mailboxes.map((id) => [id, { id, emailAddress: `${id}@masaischool.com`, displayName: null, status: 'CONNECTED', refreshTokenEnc: 'x' }]));
  allowed.clear();
  mailboxes.forEach((id) => allowed.add(id));
  state.blast = {
    id: 'b1', organizationId: 'o1', createdById: 'u1', workspaceId: 'w1', name: 'Drive', mode: 'INDIVIDUAL', sendOrder: 'PARALLEL', status: 'SENDING', toAddress: null,
    subject: 'Hi', html: '<p>Hi</p>', plainText: 'Hi', fromName: null, replyTo: null, ccAddresses: [], accountIds: mailboxes, accountLimits: {}, video: null,
    attachmentDocumentIds: [], gapSeconds: 60, note: null, ...over,
  };
  state.groups = planned.map((p, i) => ({ id: `g${i + 1}`, blastId: 'b1', seq: i + 1, status: 'PENDING', plannedAccountId: p, accountId: null, recipientCount: 1, sentAt: null, attempts: 0, createdAt: new Date() }));
}
/** Everything sent so far happened more than a pause ago. */
const pauseOver = () => state.groups.forEach((g) => g.sentAt && (g.sentAt = new Date(g.sentAt.getTime() - 61_000)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.clearAllMocks();
  sent.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  backoff.clear();
});

describe('planning rounds', () => {
  const room = (n: number, sendLimit: number | null = null) => Array.from({ length: n }, () => ({ messagesLeft: 1000, peopleLeft: 5000, sendLimit }));

  it('PARALLEL shares batches round robin; batch k of every mailbox is round k', () => {
    const p = planMailboxes(Array(10).fill(150), room(3), 'PARALLEL');
    expect(p.map((x) => x.mailbox)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
    expect(p.map((x) => x.round)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4]);
  });

  it('a mailbox at its limit drops out and the rest carry on; SEQUENTIAL fills one first', () => {
    const limited = [{ messagesLeft: 1000, peopleLeft: 5000, sendLimit: 300 }, ...room(2)];
    expect(planMailboxes(Array(6).fill(150), limited, 'PARALLEL').map((x) => x.mailbox)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(planMailboxes(Array(7).fill(150), limited, 'PARALLEL').map((x) => x.mailbox)).toEqual([0, 1, 2, 0, 1, 2, 1]);
    expect(planMailboxes(Array(4).fill(150), limited, 'SEQUENTIAL').map((x) => x.mailbox)).toEqual([0, 0, 1, 1]);
    expect(planMailboxes([150], [{ messagesLeft: 0, peopleLeft: 0, sendLimit: null }], 'PARALLEL')).toEqual([{ mailbox: null, round: null }]);
  });

  it('10 mailboxes, 1,500 recruiters, 150 per email: one round instead of ten pauses', () => {
    const p = planMailboxes(Array(10).fill(150), room(10), 'PARALLEL');
    const rounds = Math.max(...p.map((x) => x.round!));
    expect(rounds).toBe(1);
    expect(estimateMinutes(rounds, 60, 'PARALLEL', 10)).toBe(2); // a minute's pause plus the stagger
    expect(estimateMinutes(10, 60, 'SEQUENTIAL', 10)).toBe(10);
  });
});

describe('PARALLEL sending', () => {
  it('round 1 goes from every mailbox together; round 2 waits for each mailbox’s own pause', async () => {
    setup(['a1', 'a2', 'a3'], ['a1', 'a2', 'a3', 'a1', 'a2', 'a3']);
    const first = await run();
    expect(first.sent).toBe(3);
    expect(sent.map((s) => s.from).sort()).toEqual(['a1@masaischool.com', 'a2@masaischool.com', 'a3@masaischool.com']);
    expect(sent.map((s) => s.to).sort()).toEqual(['g1@corp.com', 'g2@corp.com', 'g3@corp.com']);
    expect(maxInFlight).toBe(3); // really at the same time

    pauseOver();
    sent.length = 0;
    const second = await run();
    expect(second.sent).toBe(3);
    expect(sent.map((s) => s.to).sort()).toEqual(['g4@corp.com', 'g5@corp.com', 'g6@corp.com']);
    expect(state.blast.status).toBe('COMPLETED');
  });

  it('the pause is per mailbox: one that just sent waits, the others go', async () => {
    setup(['a1', 'a2'], ['a1', 'a2', 'a1', 'a2']);
    Object.assign(state.groups[0]!, { status: 'SENT', accountId: 'a1', sentAt: new Date(Date.now() - 10_000) });
    await run();
    expect(sent.map((s) => s.from)).toEqual(['a2@masaischool.com']);
  });

  it('a mailbox that cannot send hands its batches to the others', async () => {
    setup(['a1', 'a2', 'a3'], ['a1', 'a2', 'a3', 'a1', 'a2', 'a3']);
    state.accounts.get('a2').status = 'EXPIRED';
    await run();
    expect(sent.map((s) => s.from).sort()).toEqual(['a1@masaischool.com', 'a3@masaischool.com']);
    const leftFor = (id: string) => state.groups.filter((g) => g.status === 'PENDING' && g.plannedAccountId === id).length;
    expect(leftFor('a2')).toBe(0);
    expect(leftFor('a1') + leftFor('a3')).toBe(4);
  });

  it('paused by Gmail counts too, and nothing usable means waiting with the reason', async () => {
    setup(['a1'], ['a1', 'a1']);
    backoff.set('a1', Date.now() + 60_000);
    const r = await run();
    expect(sent).toHaveLength(0);
    expect(r.waiting).toMatch(/a1@masaischool.com is paused by Gmail/);
    expect(state.blast.note).toMatch(/Waiting/);
  });

  it(`never has more than ${MAX_PARALLEL} messages out at once, but sends every mailbox's round in the run`, async () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    setup(ids, ids);
    const r = await run();
    expect(r.sent).toBe(7);
    expect(maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL);
  });

  it('claims one message per mailbox, not one per send', async () => {
    setup(['a1', 'a2'], ['a1', 'a2']);
    await run();
    const claims = (db.recruiterBlastGroup.updateMany.mock.calls as any[][]).map((c) => c[0]).filter((q) => q.data?.status === 'SENDING');
    expect(claims).toHaveLength(2);
    expect(claims.map((q) => q.where.blast.groups.none.accountId).sort()).toEqual(['a1', 'a2']);
  });
});

describe('speed: every mailbox in a round, fair order (laptop sender)', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i + 1).padStart(2, '0')}`);

  it('the default round is capped at MAX_PARALLEL; the laptop sender asks for every mailbox', async () => {
    const ids = many(13);
    setup(ids, ids);
    const capped = await run();
    // The first round takes MAX_PARALLEL; the rest follow once those mailboxes' pause is over or in the same run.
    expect(maxInFlight).toBeLessThanOrEqual(MAX_PARALLEL);
    expect(capped.sent).toBeGreaterThan(0);

    sent.length = 0;
    maxInFlight = 0;
    setup(ids, ids);
    const all = await runRecruiterWorker({ budgetMs: 45_000, send, staggerMs: () => 0, maxParallel: 50, sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); } });
    expect(all.sent).toBe(13);
    expect(maxInFlight).toBe(13); // all 13 mailboxes out together in one round
  });

  it('a capped round serves the mailbox that has waited longest first, so none is left behind', async () => {
    const ids = many(13);
    setup(ids, ids);
    // m01..m10 sent a while ago (a pause ago); m11..m13 have never sent.
    state.groups.push(...ids.slice(0, 10).map((id, i) => ({ id: `old${i}`, blastId: 'b1', seq: 100 + i, status: 'SENT', plannedAccountId: id, accountId: id, recipientCount: 1, sentAt: new Date(Date.now() - 120_000 + i * 1000), attempts: 1, createdAt: new Date() })));
    await runRecruiterWorker({ budgetMs: 45_000, send, staggerMs: () => 0, maxParallel: 3, sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); } });
    // The first round's 3 messages come from the never-sent mailboxes, not from m01..m03.
    expect(sent.slice(0, 3).map((s) => s.from.split('@')[0]).sort()).toEqual(['m11', 'm12', 'm13']);
  });

  it('the mailbox checks run together, and a mailbox that cannot send is still reported', async () => {
    const ids = many(4);
    setup(ids, ids);
    backoff.set('m02', 60_000); // Gmail asked m02 to slow down
    const r = await run();
    expect(sent.map((s) => s.from.split('@')[0]).sort()).toEqual(['m01', 'm03', 'm04']);
    expect(r.sent).toBe(3);
  });
});
