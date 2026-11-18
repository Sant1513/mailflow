import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recruiter Follow-up: who is in each audience, how recruiters are grouped and pinned to the
 * mailbox of their earlier email, threading into the original Gmail thread, waiting for (or
 * leaving) an unavailable mailbox, and a reply counting for every round of the chain.
 */
const sent: any[] = [];
const backoff = new Set<string>();
const groupsById = new Map<string, any>();
const db = {
  recruiterBlast: { findMany: vi.fn(), findUnique: vi.fn(async (): Promise<any> => ({ status: 'SENDING', rootBlastId: 'root' })), updateMany: vi.fn(), update: vi.fn(), count: vi.fn(async () => 0) },
  recruiterBlastGroup: {
    findMany: vi.fn(async (): Promise<any[]> => []),
    findFirst: vi.fn(),
    findUnique: vi.fn(async (q: any) => groupsById.get(q.where.id) ?? null),
    count: vi.fn(async () => 1),
    groupBy: vi.fn(async (): Promise<any[]> => []),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(),
  },
  recruiterBlastRecipient: { findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })), createMany: vi.fn(async () => ({ count: 0 })) },
  emailProviderAccount: { findUnique: vi.fn(), update: vi.fn() },
  documentTemplate: { findMany: vi.fn(async () => []) },
  emailSuppression: { findMany: vi.fn(async (): Promise<any[]> => []) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@/lib/queue/drain', () => ({
  backoffUntil: vi.fn(async (id: string) => (backoff.has(id) ? 60_000 : 0)),
  usageLast24h: vi.fn(async () => ({ messages: 0, totalRecipients: 0, unique: new Set() })),
  wouldExceedDaily: vi.fn(() => false),
}));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));
vi.mock('@/lib/recruiterSend/access', () => ({ allowedMailboxIds: vi.fn(async () => new Set(['a1', 'a2'])) }));
vi.mock('@/lib/recruiterSend/replies', async (orig) => ({ ...(await orig<typeof import('@/lib/recruiterSend/replies')>()), suppressRejectedRecruiter: vi.fn(), markRecruiterBounced: vi.fn() }));
vi.mock('@/lib/storage/files', () => ({ readRef: vi.fn(), BUCKET: 'b', storageEnabled: () => false }));

const fu = await import('@/lib/recruiterSend/followUp');
const { runRecruiterWorker } = await import('@/lib/recruiterSend/worker');
const { markRecruiterReplied } = await import('@/lib/recruiterSend/replies');

const cand = (over: Partial<import('@/lib/recruiterSend/followUp').Candidate> = {}) => ({ email: 'a@corp.com', name: null, data: null, sourceGroupId: 'g1', replied: false, opened: null, bounced: false, suppressed: false, lastSentAt: null, ...over });

describe('the follow-up subject', () => {
  it('has exactly one Re:', () => {
    expect(fu.followUpSubject('Hiring drive')).toBe('Re: Hiring drive');
    expect(fu.followUpSubject('Re: Hiring drive')).toBe('Re: Hiring drive');
    expect(fu.followUpSubject('RE: re: Fwd: Hiring drive')).toBe('Re: Hiring drive');
  });
});

describe('audience segments (multi-select)', () => {
  const list = [
    cand({ email: 'unknown@c.com' }), // last email in BCC: opens unknown
    cand({ email: 'replied@c.com', replied: true, opened: true }),
    cand({ email: 'bounced@c.com', bounced: true }),
    cand({ email: 'bouncedreplied@c.com', bounced: true, replied: true }),
    cand({ email: 'opened@c.com', opened: true }),
    cand({ email: 'unopened@c.com', opened: false }),
  ];
  const pick = (segs: Parameters<typeof fu.inSegments>[1]) => list.filter((c) => fu.inSegments(c, segs)).map((c) => c.email);

  it('puts every recruiter in exactly one segment; bounced ones in none', () => {
    expect(list.map((c) => fu.segmentOf(c))).toEqual(['NO_REPLY_UNKNOWN', 'REPLIED', null, null, 'NO_REPLY_OPENED', 'NO_REPLY_UNOPENED']);
  });
  it('someone on the suppression list is in no segment, whatever else is true of them', () => {
    expect(fu.segmentOf(cand({ suppressed: true }))).toBeNull();
    expect(fu.segmentOf(cand({ suppressed: true, replied: true, opened: true }))).toBeNull();
    expect(fu.inSegments(cand({ suppressed: true }), [...fu.FOLLOW_UP_SEGMENTS])).toBe(false);
    expect(fu.segmentCounts([cand({ suppressed: true }), cand({ email: 'ok@c.com', opened: true })])).toMatchObject({ NO_REPLY_OPENED: 1, bounced: 1, total: 2 });
  });
  it('a reply wins over opened: someone who replied is only ever in REPLIED', () => {
    expect(fu.segmentOf(cand({ replied: true, opened: false }))).toBe('REPLIED');
  });
  it('ticking several segments adds them up, with no one counted twice', () => {
    expect(pick(['NO_REPLY_OPENED', 'NO_REPLY_UNOPENED'])).toEqual(['opened@c.com', 'unopened@c.com']);
    expect(pick(['NO_REPLY_OPENED', 'NO_REPLY_OPENED', 'REPLIED'])).toEqual(['replied@c.com', 'opened@c.com']);
    expect(pick(fu.NOT_REPLIED_SEGMENTS)).toEqual(['unknown@c.com', 'opened@c.com', 'unopened@c.com']);
  });
  it('everyone leaves out bounced addresses; nothing ticked is nobody', () => {
    expect(pick([...fu.FOLLOW_UP_SEGMENTS])).toEqual(['unknown@c.com', 'replied@c.com', 'opened@c.com', 'unopened@c.com']);
    expect(pick([])).toEqual([]);
  });
  it('counts each segment, bounced apart, and the total ever sent', () => {
    expect(fu.segmentCounts(list)).toEqual({ NO_REPLY_OPENED: 1, NO_REPLY_UNOPENED: 1, NO_REPLY_UNKNOWN: 1, REPLIED: 1, bounced: 2, total: 6 });
    expect(fu.segmentCounts([])).toEqual({ NO_REPLY_OPENED: 0, NO_REPLY_UNOPENED: 0, NO_REPLY_UNKNOWN: 0, REPLIED: 0, bounced: 0, total: 0 });
  });
  it('the segment counts always add up to everyone who was sent an email', () => {
    const c = fu.segmentCounts(list);
    expect(c.NO_REPLY_OPENED + c.NO_REPLY_UNOPENED + c.NO_REPLY_UNKNOWN + c.REPLIED + c.bounced).toBe(c.total);
  });
  it('reads saved values: lists, the first version’s names, junk and empty', () => {
    expect(fu.parseSegments('NO_REPLY_UNOPENED,REPLIED')).toEqual(['NO_REPLY_UNOPENED', 'REPLIED']);
    expect(fu.parseSegments('REPLIED, NO_REPLY_OPENED')).toEqual(['NO_REPLY_OPENED', 'REPLIED']); // stable order, spaces ok
    expect(fu.parseSegments('NOT_REPLIED')).toEqual(fu.NOT_REPLIED_SEGMENTS);
    expect(fu.parseSegments('NOT_REPLIED_OPENED')).toEqual(['NO_REPLY_OPENED']);
    expect(fu.parseSegments('NOT_REPLIED_UNOPENED')).toEqual(['NO_REPLY_UNOPENED']);
    expect(fu.parseSegments('EVERYONE')).toEqual([...fu.FOLLOW_UP_SEGMENTS]);
    expect(fu.parseSegments('NOT_REPLIED,REPLIED')).toEqual([...fu.FOLLOW_UP_SEGMENTS]);
    expect(fu.parseSegments('bogus,,NO_REPLY_OPENED')).toEqual(['NO_REPLY_OPENED']);
    expect(fu.parseSegments('')).toEqual([]);
    expect(fu.parseSegments(null)).toEqual([]);
    expect(fu.parseSegments(undefined)).toEqual([]);
  });
});

describe('grouping and mailboxes', () => {
  it('BCC keeps recruiters of the same earlier email together, in messages of at most groupSize', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, sourceGroupId: 'gA' })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `y${i}`, sourceGroupId: 'gB' })),
      { id: 'n1', sourceGroupId: null },
    ];
    const g = fu.followUpGroups(rows, 'BCC', 3);
    expect(g.map((x) => [x.sourceGroupId, x.ids.length])).toEqual([['gA', 3], ['gA', 2], ['gB', 2], [null, 1]]);
  });
  it('individual copies: one message each, replying to that recruiter’s last email', () => {
    const g = fu.followUpGroups([{ id: 'a', sourceGroupId: 'g1' }, { id: 'b', sourceGroupId: null }], 'INDIVIDUAL', 250);
    expect(g).toEqual([{ ids: ['a'], sourceGroupId: 'g1' }, { ids: ['b'], sourceGroupId: null }]);
  });
  const room = (accountId: string, left = 10) => ({ accountId, messagesLeft: left, peopleLeft: 1000, sendLimit: null });
  it('pins a reply to the mailbox of the earlier email', () => {
    const out = fu.planFollowUpMailboxes([{ size: 1, pinnedAccountId: 'a2' }, { size: 1, pinnedAccountId: 'a1' }, { size: 1, pinnedAccountId: 'a2' }], [room('a1'), room('a2')], 'WAIT');
    expect(out.map((o) => o.mailbox)).toEqual([1, 0, 1]);
    expect(out.map((o) => o.round)).toEqual([1, 1, 2]);
  });
  it('a pinned mailbox with no room: WAIT sends it later, FALLBACK uses another mailbox', () => {
    const groups = [{ size: 1, pinnedAccountId: 'a1' }, { size: 1, pinnedAccountId: 'a1' }];
    expect(fu.planFollowUpMailboxes(groups, [room('a1', 1), room('a2')], 'WAIT').map((o) => o.mailbox)).toEqual([0, null]);
    expect(fu.planFollowUpMailboxes(groups, [room('a1', 1), room('a2')], 'FALLBACK').map((o) => o.mailbox)).toEqual([0, 1]);
  });
  it('recruiters new to the chain are spread over the mailboxes', () => {
    const out = fu.planFollowUpMailboxes([{ size: 1, pinnedAccountId: null }, { size: 1, pinnedAccountId: null }], [room('a1'), room('a2')], 'WAIT');
    expect(out.map((o) => o.mailbox)).toEqual([0, 1]);
  });
});

describe('the chain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('works out each recruiter from every round: latest email, replied anywhere, bounced anywhere', async () => {
    const t = (d: string) => new Date(d);
    db.recruiterBlastRecipient.findMany.mockResolvedValueOnce([
      { email: 'A@c.com', name: 'A', data: { Company: 'Acme' }, status: 'SENT', groupId: 'g1', sentAt: t('2026-11-01'), repliedAt: null, openCount: 0, blast: { mode: 'BCC' } },
      { email: 'a@c.com', name: 'A', data: { Company: 'Acme' }, status: 'SENT', groupId: 'g9', sentAt: t('2026-11-05'), repliedAt: null, openCount: 2, blast: { mode: 'INDIVIDUAL' } },
      { email: 'b@c.com', name: null, data: null, status: 'SENT', groupId: 'g1', sentAt: t('2026-11-01'), repliedAt: t('2026-11-02'), openCount: 0, blast: { mode: 'BCC' } },
      { email: 'c@c.com', name: null, data: null, status: 'SENT', groupId: 'g2', sentAt: t('2026-11-01'), repliedAt: null, openCount: 0, blast: { mode: 'BCC' } },
      { email: 'c@c.com', name: null, data: null, status: 'BOUNCED', groupId: 'g3', sentAt: t('2026-11-05'), repliedAt: null, openCount: 0, blast: { mode: 'INDIVIDUAL' } },
      { email: 'd@c.com', name: null, data: null, status: 'SKIPPED', groupId: null, sentAt: null, repliedAt: null, openCount: 0, blast: { mode: 'BCC' } },
    ]);
    const list = await fu.chainCandidates('root');
    expect(list.map((c) => c.email)).toEqual(['a@c.com', 'b@c.com', 'c@c.com']); // d was never sent anything
    expect(list[0]).toMatchObject({ sourceGroupId: 'g9', opened: true, replied: false, data: { Company: 'Acme' } });
    expect(list[1]).toMatchObject({ replied: true, opened: null });
    expect(list[2]).toMatchObject({ bounced: true });
  });

  it('flags everyone on the workspace suppression list (any case), and only asks when given a workspace', async () => {
    const row = (email: string) => ({ email, name: null, data: null, status: 'SENT', groupId: 'g1', sentAt: new Date('2026-11-01'), repliedAt: null, openCount: 0, blast: { mode: 'BCC' } });
    db.recruiterBlastRecipient.findMany.mockResolvedValueOnce([row('a@c.com'), row('b@c.com')]);
    db.emailSuppression.findMany.mockResolvedValueOnce([{ email: 'B@C.com' }]);
    const list = await fu.chainCandidates('root', 'w1');
    expect(list.map((c) => [c.email, c.suppressed])).toEqual([['a@c.com', false], ['b@c.com', true]]);
    expect(db.emailSuppression.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'w1', email: { in: ['a@c.com', 'b@c.com'], mode: 'insensitive' } } }));
    db.emailSuppression.findMany.mockClear();
    db.recruiterBlastRecipient.findMany.mockResolvedValueOnce([row('a@c.com')]);
    expect((await fu.chainCandidates('root'))[0]!.suppressed).toBe(false);
    expect(db.emailSuppression.findMany).not.toHaveBeenCalled();
  });

  it('a reply counts for every round of the chain', async () => {
    db.recruiterBlast.findUnique.mockResolvedValueOnce({ rootBlastId: 'root' });
    await markRecruiterReplied('round2', 'Priya@C.com', new Date('2026-11-06'));
    expect(db.recruiterBlastRecipient.updateMany).toHaveBeenCalledWith({
      where: { blast: { OR: [{ id: 'root' }, { rootBlastId: 'root' }] }, email: 'priya@c.com', repliedAt: null },
      data: { repliedAt: new Date('2026-11-06') },
    });
    db.recruiterBlast.findUnique.mockResolvedValueOnce({ rootBlastId: null });
    await markRecruiterReplied('b1', 'x@c.com', new Date());
    expect(db.recruiterBlastRecipient.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ blast: { OR: [{ id: 'b1' }, { rootBlastId: 'b1' }] } }) }));
  });
});

describe('editing the list', () => {
  beforeEach(() => vi.clearAllMocks());
  const row = (email: string, status: string) => ({ email, name: null, data: null, status, groupId: 'g1', sentAt: new Date('2026-11-01'), repliedAt: null, openCount: 0, blast: { mode: 'BCC' } });

  it('never adds an address that bounced, even one that has no sent email (typed in by hand)', async () => {
    // 1) the chain, 2) who is already in the draft, 3) who bounced
    db.recruiterBlastRecipient.findMany
      .mockResolvedValueOnce([row('ok@c.com', 'SENT')])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ email: 'Gone@C.com' }]);
    const res = await fu.addToAudience('draft', 'root', ['gone@c.com', 'OK@c.com', 'new@c.com']);
    expect(res).toEqual({ added: 2, fromChain: 1, skippedBounced: 1 });
    const created = (db.recruiterBlastRecipient.createMany.mock.calls[0] as any[])[0].data.map((r: any) => r.email);
    expect(created).toEqual(['ok@c.com', 'new@c.com']);
  });
  it('does not add anyone twice, and adds nothing for an empty request', async () => {
    db.recruiterBlastRecipient.findMany.mockResolvedValueOnce([row('a@c.com', 'SENT')]).mockResolvedValueOnce([{ email: 'a@c.com' }]).mockResolvedValueOnce([]);
    expect((await fu.addToAudience('draft', 'root', ['a@c.com'])).added).toBe(0);
    expect(await fu.addToAudience('draft', 'root', ['', '  '])).toEqual({ added: 0, fromChain: 0, skippedBounced: 0 });
    expect(db.recruiterBlastRecipient.createMany).not.toHaveBeenCalled();
  });
});

describe('threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupsById.clear();
    groupsById.set('r2g', { accountId: 'a1', gmailThreadId: 'T1', messageIdHeader: '<m2@x>', inReplyToGroupId: 'r1g' });
    groupsById.set('r1g', { accountId: 'a1', gmailThreadId: 'T1', messageIdHeader: '<m1@x>', inReplyToGroupId: null });
  });
  it('continues the thread from the same mailbox with the whole References chain', async () => {
    expect(await fu.threadFor('r2g', 'a1')).toEqual({ threadId: 'T1', inReplyTo: '<m2@x>', references: '<m1@x> <m2@x>' });
  });
  it('starts a new thread from any other mailbox (Gmail threads inside one mailbox)', async () => {
    expect(await fu.threadFor('r2g', 'a2')).toBeNull();
  });
  it('starts a new thread when the earlier email has no Gmail ids', async () => {
    groupsById.set('r2g', { accountId: 'a1', gmailThreadId: null, messageIdHeader: null, inReplyToGroupId: null });
    expect(await fu.threadFor('r2g', 'a1')).toBeNull();
  });
});

describe('sending a follow-up', () => {
  const acc = (id: string, email: string) => ({ id, emailAddress: email, displayName: null, status: 'CONNECTED', refreshTokenEnc: 'x' });
  const blast = (over: Record<string, unknown> = {}) => ({
    id: 'f1', workspaceId: 'w1', organizationId: 'org1', createdById: 'u1', mode: 'INDIVIDUAL', toAddress: null, subject: 'Re: Hiring partners', html: '<p>Just checking in</p>', plainText: 'Just checking in',
    fromName: 'Masai', replyTo: null, accountIds: ['a1', 'a2'], accountLimits: {}, video: null, attachmentDocumentIds: [], gapSeconds: 0, note: null, sendOrder: 'SEQUENTIAL',
    parentBlastId: 'b1', rootBlastId: 'b1', round: 2, onMailboxDown: 'WAIT', ccAddresses: [], ...over,
  });
  const capture = async (account: any, input: any) => {
    sent.push({ from: account.emailAddress, ...input });
    return { providerMessageId: 'm9', threadId: input.threadId ?? 'NEW', messageIdHeader: '<new@x>' };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    backoff.clear();
    groupsById.clear();
    groupsById.set('f1g', { inReplyToGroupId: 'r1g' });
    groupsById.set('r1g', { accountId: 'a1', gmailThreadId: 'T1', messageIdHeader: '<m1@x>', inReplyToGroupId: null });
    db.recruiterBlastGroup.findFirst.mockImplementation(async (q: any) => (q.where.status === 'PENDING' ? { id: 'f1g', seq: 1, attempts: 0, inReplyToGroupId: 'r1g', plannedAccountId: 'a1' } : null));
    db.recruiterBlastRecipient.findMany.mockResolvedValue([{ id: 'r1', email: 'a@corp.com', name: null, data: null, repliedAt: null }]);
    db.emailProviderAccount.findUnique.mockImplementation(async (q: any) => (q.where.id === 'a1' ? acc('a1', 'one@masaischool.com') : acc('a2', 'two@masaischool.com')));
  });

  it('replies into the original thread from the original mailbox', async () => {
    db.recruiterBlast.findMany.mockResolvedValueOnce([blast()]).mockResolvedValue([]);
    const r = await runRecruiterWorker({ budgetMs: 45_000, send: capture });
    expect(r.sent).toBe(1);
    expect(sent[0]).toMatchObject({ from: 'one@masaischool.com', to: 'a@corp.com', threadId: 'T1', inReplyTo: '<m1@x>', references: '<m1@x>' });
  });

  it('WAIT: when the original mailbox is paused it sends nothing and says why', async () => {
    backoff.add('a1');
    db.recruiterBlast.findMany.mockResolvedValueOnce([blast({ onMailboxDown: 'WAIT' })]).mockResolvedValue([]);
    const r = await runRecruiterWorker({ budgetMs: 45_000, send: capture });
    expect(sent).toHaveLength(0);
    expect(r.waiting).toContain('paused by Gmail');
  });

  it('FALLBACK: when the original mailbox is paused another one sends it, as a new thread', async () => {
    backoff.add('a1');
    db.recruiterBlast.findMany.mockResolvedValueOnce([blast({ onMailboxDown: 'FALLBACK' })]).mockResolvedValue([]);
    const r = await runRecruiterWorker({ budgetMs: 45_000, send: capture });
    expect(r.sent).toBe(1);
    expect(sent[0].from).toBe('two@masaischool.com');
    expect(sent[0].threadId).toBeUndefined();
    expect(sent[0].inReplyTo).toBeUndefined();
  });

  it('drops a recruiter who replied after the follow-up was prepared', async () => {
    db.recruiterBlast.findMany.mockResolvedValueOnce([blast()]).mockResolvedValue([]);
    db.recruiterBlastRecipient.findMany.mockResolvedValue([
      { id: 'r1', email: 'a@corp.com', name: null, data: null, repliedAt: null },
      { id: 'r2', email: 'b@corp.com', name: null, data: null, repliedAt: new Date() },
    ]);
    await runRecruiterWorker({ budgetMs: 45_000, send: capture });
    expect(sent.map((s) => s.to)).toEqual(['a@corp.com']);
    expect(db.recruiterBlastRecipient.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['r2'] } }, data: expect.objectContaining({ status: 'SKIPPED' }) }));
  });
});
