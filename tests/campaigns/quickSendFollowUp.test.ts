import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Quick Send follow-up building blocks with a mocked database: the summary of how the emails will go
 * out, the In-Reply-To / References chain across rounds, and "replied since it was prepared".
 * The same flow against a real database is scripts/qa-quick-send-follow-up.ts.
 */
const jobs = new Map<string, { messageIdHeader: string | null; inReplyToJobId: string | null }>();
const db = {
  emailJob: { findUnique: vi.fn(async (q: any) => jobs.get(q.where.id) ?? null), findMany: vi.fn(async (): Promise<any[]> => []) },
  conversation: { findFirst: vi.fn(async (): Promise<any> => null), findMany: vi.fn(async (): Promise<any[]> => []) },
  emailProviderAccount: { findMany: vi.fn(async (): Promise<any[]> => []) },
  emailTrackingEvent: { findMany: vi.fn(async (): Promise<any[]> => []) },
  emailSuppression: { findMany: vi.fn(async (): Promise<any[]> => []) },
  dataset: { findMany: vi.fn(async (): Promise<any[]> => []) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/campaigns/fallback', () => ({ fallbackOptIns: vi.fn(async () => new Set<string>(['shared'])) }));

const fu = await import('@/lib/quickSend/followUp');

describe('how the follow-up emails go out', () => {
  const plan = (over: Partial<import('@/lib/quickSend/followUp').JobPlan> = {}) => ({ accountId: 'a1', accountEmail: 'one@x.test', accountName: null, replyThreadId: 'T1', inReplyToJobId: 'j1', blockedBy: null, ...over });
  it('counts replies in a thread, new threads and the mailboxes that block', () => {
    const s = fu.planSummary(new Map([
      ['a@c.com', plan()],
      ['b@c.com', plan({ replyThreadId: null, inReplyToJobId: null })],
      ['c@c.com', plan({ blockedBy: 'gone@x.test' })],
      ['d@c.com', plan({ blockedBy: 'gone@x.test' })],
    ]));
    expect(s).toEqual({ replying: 1, newThread: 1, blocked: ['gone@x.test'] });
    expect(fu.planSummary(new Map())).toEqual({ replying: 0, newThread: 0, blocked: [] });
  });
});

describe('plan per person', () => {
  beforeEach(() => vi.clearAllMocks());
  const sender = { id: 'a1', emailAddress: 'one@x.test', displayName: 'one' };
  const job = (toEmail: string, accountId: string | null, thread: string | null = 'T', msg: string | null = '<m@x>') => ({ id: `j-${toEmail}`, toEmail, emailProviderAccountId: accountId, gmailThreadId: thread, messageIdHeader: msg });
  const acct = (id: string, status = 'CONNECTED') => ({ id, emailAddress: `${id}@x.test`, displayName: id, status });

  it('replies from the sender’s own mailbox or a shared backup; anything else blocks WAIT and is a new thread for FALLBACK', async () => {
    db.emailJob.findMany.mockResolvedValue([job('own@c.com', 'a1'), job('shared@c.com', 'shared'), job('private@c.com', 'private')]);
    db.emailProviderAccount.findMany.mockResolvedValue([acct('a1'), acct('shared'), acct('private')]);
    const wait = await fu.planFollowUpJobs({ rootCampaignId: 'r', organizationId: 'o', onMailboxDown: 'WAIT', sender, emails: ['own@c.com', 'SHARED@c.com', 'private@c.com', 'new@c.com'] });
    expect(wait.get('own@c.com')).toMatchObject({ accountId: 'a1', replyThreadId: 'T', blockedBy: null });
    expect(wait.get('shared@c.com')).toMatchObject({ accountId: 'shared', replyThreadId: 'T', blockedBy: null });
    expect(wait.get('private@c.com')).toMatchObject({ blockedBy: 'private@x.test' });
    expect(wait.get('new@c.com')).toMatchObject({ accountId: 'a1', replyThreadId: null, inReplyToJobId: null, blockedBy: null });
    const fb = await fu.planFollowUpJobs({ rootCampaignId: 'r', organizationId: 'o', onMailboxDown: 'FALLBACK', sender, emails: ['private@c.com'] });
    expect(fb.get('private@c.com')).toMatchObject({ accountId: 'a1', replyThreadId: null, blockedBy: null });
  });
  it('a disconnected earlier mailbox: WAIT keeps the thread (it waits), FALLBACK starts a new thread now', async () => {
    db.emailJob.findMany.mockResolvedValue([job('x@c.com', 'a1')]);
    db.emailProviderAccount.findMany.mockResolvedValue([acct('a1', 'EXPIRED')]);
    expect((await fu.planFollowUpJobs({ rootCampaignId: 'r', organizationId: 'o', onMailboxDown: 'WAIT', sender, emails: ['x@c.com'] })).get('x@c.com')).toMatchObject({ replyThreadId: 'T', blockedBy: null });
    expect((await fu.planFollowUpJobs({ rootCampaignId: 'r', organizationId: 'o', onMailboxDown: 'FALLBACK', sender, emails: ['x@c.com'] })).get('x@c.com')).toMatchObject({ replyThreadId: null });
  });
  it('an earlier email without Gmail ids can not be replied to: new thread', async () => {
    db.emailJob.findMany.mockResolvedValue([job('x@c.com', 'a1', null, null)]);
    db.emailProviderAccount.findMany.mockResolvedValue([acct('a1')]);
    expect((await fu.planFollowUpJobs({ rootCampaignId: 'r', organizationId: 'o', onMailboxDown: 'WAIT', sender, emails: ['x@c.com'] })).get('x@c.com')).toMatchObject({ replyThreadId: null });
  });
  it('nobody to plan for asks the database nothing', async () => {
    expect((await fu.planFollowUpJobs({ rootCampaignId: 'r', organizationId: 'o', onMailboxDown: 'WAIT', sender, emails: ['', '  '] })).size).toBe(0);
    expect(db.emailJob.findMany).not.toHaveBeenCalled();
  });
});

describe('reply headers across rounds', () => {
  beforeEach(() => { jobs.clear(); db.emailJob.findUnique.mockClear(); });
  it('In-Reply-To is the latest earlier email; References run from the first to the latest', async () => {
    jobs.set('r2', { messageIdHeader: '<m2@x>', inReplyToJobId: 'r1' });
    jobs.set('r1', { messageIdHeader: '<m1@x>', inReplyToJobId: null });
    expect(await fu.threadHeaders('r2')).toEqual({ inReplyTo: '<m2@x>', references: '<m1@x> <m2@x>' });
    expect(await fu.threadHeaders('r1')).toEqual({ inReplyTo: '<m1@x>', references: '<m1@x>' });
  });
  it('a missing or id-less earlier email gives no headers (it then starts a new thread)', async () => {
    expect(await fu.threadHeaders('nope')).toBeNull();
    jobs.set('x', { messageIdHeader: null, inReplyToJobId: null });
    expect(await fu.threadHeaders('x')).toBeNull();
  });
  it('skips an earlier email with no Message-ID but keeps the rest of the chain', async () => {
    jobs.set('b', { messageIdHeader: '<b@x>', inReplyToJobId: 'a' });
    jobs.set('a', { messageIdHeader: null, inReplyToJobId: 'z' });
    jobs.set('z', { messageIdHeader: '<z@x>', inReplyToJobId: null });
    expect(await fu.threadHeaders('b')).toEqual({ inReplyTo: '<b@x>', references: '<z@x> <b@x>' });
  });
  it('a circular chain can not loop forever', async () => {
    jobs.set('p', { messageIdHeader: '<p@x>', inReplyToJobId: 'q' });
    jobs.set('q', { messageIdHeader: '<q@x>', inReplyToJobId: 'p' });
    const h = await fu.threadHeaders('p');
    expect(h?.inReplyTo).toBe('<p@x>');
    expect(db.emailJob.findUnique.mock.calls.length).toBeLessThanOrEqual(30);
  });
});

describe('replied since it was prepared', () => {
  beforeEach(() => vi.clearAllMocks());
  it('asks for a human reply in that thread from that moment on', async () => {
    const since = new Date('2026-11-18T10:00:00Z');
    db.conversation.findFirst.mockResolvedValueOnce({ id: 'c1' });
    expect(await fu.repliedSince('T-1', since)).toBe(true);
    expect(db.conversation.findFirst).toHaveBeenCalledWith({
      where: { gmailThreadId: 'T-1', messages: { some: { direction: 'INBOUND', classification: 'HUMAN_REPLY', sentAt: { gte: since } } } },
      select: { id: true },
    });
    db.conversation.findFirst.mockResolvedValueOnce(null);
    expect(await fu.repliedSince('T-1', since)).toBe(false);
  });
});
