import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The sync loop's progress guarantees. A mailbox that hadn't synced for weeks listed ~8,000
 * messages; listing alone used the whole time budget, the run stopped before its first batch,
 * the cursor never moved, and every later run stalled on the same window (2026-11-02).
 */
const db = {
  conversationMessage: { findMany: vi.fn().mockResolvedValue([]) },
  conversation: { findMany: vi.fn().mockResolvedValue([]) },
  emailJob: { findMany: vi.fn().mockResolvedValue([]) },
  contact: { findMany: vi.fn().mockResolvedValue([]) },
  recruiterBlastGroup: { findMany: vi.fn().mockResolvedValue([]) },
  emailProviderAccount: { update: vi.fn().mockResolvedValue({}) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/gmail/oauth', () => ({ authorizedClientFor: vi.fn(), markAccountExpired: vi.fn() }));
vi.mock('@/lib/gmail/ingest', () => ({
  ingestInboundMessage: vi.fn().mockResolvedValue({ status: 'STORED' }),
  RetryLaterError: class RetryLaterError extends Error {},
}));

const { syncAccount, isTransientSyncError } = await import('@/lib/gmail/sync');
const { ingestInboundMessage, RetryLaterError } = await import('@/lib/gmail/ingest');

const account = { id: 'acc1', emailAddress: 'me@example.com', workspaceId: 'w1', gmailHistoryId: '100' } as any;

function sourceWith(count: number, listDelayMs = 0) {
  const entries = Array.from({ length: count }, (_, i) => ({
    messageId: `m${i}`,
    threadId: `t${i}`,
    labelIds: ['INBOX'],
    historyRecordId: String(101 + i),
  }));
  return {
    listHistory: vi.fn(async (_start: string, _max?: number) => {
      if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs));
      return { entries, historyId: '999' };
    }),
    listRecentInbox: vi.fn(),
    getMessageMetadata: vi.fn(async (_id: string): Promise<any> => ({ threadId: 'tx', labelIds: ['INBOX'], fromEmail: 'stranger@x.com', inReplyTo: null, references: null })),
    getMessage: vi.fn(),
    getProfileHistoryId: vi.fn(),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('Gmail sync progress', () => {
  it('lists the history in windows rather than the whole backlog at once', async () => {
    const source = sourceWith(3);
    await syncAccount(account, source as any);
    const max = source.listHistory.mock.calls[0]?.[1];
    expect(typeof max).toBe('number');
    expect(max).toBeGreaterThan(0);
  });

  it('still finishes one batch and moves the cursor when listing used the whole budget', async () => {
    const source = sourceWith(100, 30);
    const r = await syncAccount(account, source as any, { budgetMs: 10 });
    expect(r.remaining).toBeLessThan(100);
    expect(r.newHistoryId).not.toBeNull();
    expect(db.emailProviderAccount.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ gmailHistoryId: r.newHistoryId }) }));
  });

  it('moves the cursor to the end of the window once everything listed is done', async () => {
    const r = await syncAccount(account, sourceWith(5) as any);
    expect(r.remaining).toBe(0);
    expect(r.newHistoryId).toBe('999');
  });

  it('fetches replies in threads started by a Recruiter Bulk Send', async () => {
    db.recruiterBlastGroup.findMany.mockImplementation(async ({ where }: any) =>
      where.OR.some((o: any) => o.gmailThreadId?.in?.includes('t1')) ? [{ gmailThreadId: 't1', messageIdHeader: '<s1>', accountId: 'acc1' }] : [],
    );
    const source = sourceWith(3);
    source.getMessage.mockResolvedValue({ id: 'm1', threadId: 't1', labelIds: ['INBOX'], payload: { headers: [] } });
    await syncAccount(account, source as any);
    expect(source.getMessage).toHaveBeenCalledWith('m1');
    expect(source.getMessage).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
    db.recruiterBlastGroup.findMany.mockReset().mockResolvedValue([]);
  });
});

describe('Gmail sync — unsubscribe emails from the Unsubscribe button', () => {
  it('ingests a fresh-thread "Unsubscribe rb-…" from someone who is not a contact (a BCC recruiter)', async () => {
    const source = sourceWith(1);
    source.getMessageMetadata.mockResolvedValue({
      threadId: 'new-thread',
      labelIds: ['INBOX'],
      fromEmail: 'recruiter@company.com',
      inReplyTo: null,
      references: null,
      subject: 'Unsubscribe rb-abcdefgh1234.sig',
    } as any);
    source.getMessage.mockResolvedValue({ id: 'm0', threadId: 'new-thread', labelIds: ['INBOX'], payload: { headers: [] } });
    await syncAccount(account, source as any);
    expect(source.getMessage).toHaveBeenCalledWith('m0');
    expect(ingestInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('a plain "Unsubscribe" from a stranger still has to pass the usual rules', async () => {
    const source = sourceWith(1);
    source.getMessageMetadata.mockResolvedValue({
      threadId: 'new-thread', labelIds: ['INBOX'], fromEmail: 'stranger@x.com', inReplyTo: null, references: null, subject: 'Unsubscribe',
    } as any);
    await syncAccount(account, source as any);
    expect(source.getMessage).not.toHaveBeenCalled();
    expect(ingestInboundMessage).not.toHaveBeenCalled();
  });
});

describe('Gmail sync — the cursor and errors', () => {
  const coded = (id: string) => ({
    threadId: `nt-${id}`, labelIds: ['INBOX'], fromEmail: 'r@company.com', inReplyTo: null, references: null, subject: `Unsubscribe cj-token${id}-12345678`,
  });

  it('holds the cursor before a message that failed for a reason that may pass (Gmail 503)', async () => {
    const source = sourceWith(4); // records 101..104
    source.getMessageMetadata.mockImplementation(async (id: string) => {
      if (id === 'm2') throw Object.assign(new Error('Backend Error'), { code: 503 });
      return coded(id) as any;
    });
    source.getMessage.mockImplementation(async (id: string) => ({ id, threadId: 'x', labelIds: ['INBOX'], payload: { headers: [] } }));
    const r = await syncAccount(account, source as any);
    expect(r.remaining).toBeGreaterThan(0);
    expect(r.newHistoryId).toBe('102'); // m1's record: m2 (record 103) is fetched again next run
  });

  it('holds the cursor when ingest asks to retry (bounce suppression failed)', async () => {
    const source = sourceWith(3);
    source.getMessageMetadata.mockImplementation(async (id: string) => coded(id) as any);
    source.getMessage.mockImplementation(async (id: string) => ({ id, threadId: 'x', labelIds: ['INBOX'], payload: { headers: [] } }));
    vi.mocked(ingestInboundMessage).mockImplementation(async (_a: any, msg: any) => {
      if (msg.gmailMessageId === 'm0') throw new RetryLaterError('db down');
      return { status: 'STORED' } as any;
    });
    const r = await syncAccount(account, source as any);
    // The first message failed: nothing before it in this window, so the stored cursor stays put.
    expect(r.newHistoryId).toBeNull();
    // Only the "stuck since" mark is written; the history cursor is untouched.
    expect(db.emailProviderAccount.update).toHaveBeenCalledTimes(1);
    expect(db.emailProviderAccount.update).toHaveBeenCalledWith({ where: { id: 'acc1' }, data: { syncStuckSince: expect.any(Date) } });
    vi.mocked(ingestInboundMessage).mockReset().mockResolvedValue({ status: 'STORED' } as any);
  });

  it('skips a message that has held the mailbox for more than 6 hours, and clears the mark', async () => {
    const source = sourceWith(3);
    source.getMessageMetadata.mockImplementation(async (id: string) => coded(id) as any);
    source.getMessage.mockImplementation(async (id: string) => ({ id, threadId: 'x', labelIds: ['INBOX'], payload: { headers: [] } }));
    vi.mocked(ingestInboundMessage).mockImplementation(async (_a: any, msg: any) => {
      if (msg.gmailMessageId === 'm0') throw new RetryLaterError('keeps failing');
      return { status: 'STORED' } as any;
    });
    const stuck = { ...account, syncStuckSince: new Date(Date.now() - 7 * 3_600_000) };
    const r = await syncAccount(stuck, source as any);
    expect(r.remaining).toBe(0);
    expect(r.newHistoryId).toBe('999');
    expect(r.errors.some((e) => e.includes('skipped after 6 h'))).toBe(true);
    expect(db.emailProviderAccount.update).toHaveBeenCalledWith({ where: { id: 'acc1' }, data: expect.objectContaining({ gmailHistoryId: '999', syncStuckSince: null }) });
    vi.mocked(ingestInboundMessage).mockReset().mockResolvedValue({ status: 'STORED' } as any);
  });

  it('moves past a message that failed for good, so one bad message never stalls the mailbox', async () => {
    const source = sourceWith(3);
    source.getMessageMetadata.mockImplementation(async (id: string) => {
      if (id === 'm1') throw Object.assign(new Error('Invalid id value'), { code: 400 });
      return coded(id) as any;
    });
    source.getMessage.mockImplementation(async (id: string) => ({ id, threadId: 'x', labelIds: ['INBOX'], payload: { headers: [] } }));
    const r = await syncAccount(account, source as any);
    expect(r.errors).toHaveLength(1);
    expect(r.remaining).toBe(0);
    expect(r.newHistoryId).toBe('999');
  });

  it('classifies errors', () => {
    expect(isTransientSyncError(Object.assign(new Error('x'), { code: 429 }))).toBe(true);
    expect(isTransientSyncError(Object.assign(new Error('x'), { response: { status: 502 } }))).toBe(true);
    expect(isTransientSyncError(new Error('Transaction API error: P2028 timed out'))).toBe(true);
    expect(isTransientSyncError(new Error('socket hang up'))).toBe(true);
    expect(isTransientSyncError(Object.assign(new Error('Requested entity was not found.'), { code: 404 }))).toBe(false);
    expect(isTransientSyncError(Object.assign(new Error('Invalid id value'), { code: 400 }))).toBe(false);
  });
});
