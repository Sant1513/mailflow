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
  emailProviderAccount: { update: vi.fn().mockResolvedValue({}) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/gmail/oauth', () => ({ authorizedClientFor: vi.fn(), markAccountExpired: vi.fn() }));
vi.mock('@/lib/gmail/ingest', () => ({ ingestInboundMessage: vi.fn().mockResolvedValue({ status: 'STORED' }) }));

const { syncAccount } = await import('@/lib/gmail/sync');

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
    getMessageMetadata: vi.fn(async () => ({ threadId: 'tx', labelIds: ['INBOX'], fromEmail: 'stranger@x.com', inReplyTo: null, references: null })),
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
});
