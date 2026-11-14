import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * One email delivered to two connected mailboxes of a workspace (a Google group address plus a
 * CC) is stored once. Bounce/unsubscribe handling still runs for the second copy.
 */
const tx = {
  conversation: {
    create: vi.fn(async ({ data }: any) => ({ id: 'c-new', assigneeId: null, recruiterBlastId: null, ...data })),
    update: vi.fn(),
  },
  conversationMessage: { create: vi.fn(async () => ({ id: 'msg-new' })), findFirst: vi.fn(async (_q: any): Promise<any> => null) },
  record: { updateMany: vi.fn() },
  recipientHistory: { create: vi.fn() },
  notification: { create: vi.fn() },
};
const db = {
  conversationMessage: { findUnique: vi.fn(async () => null) },
  conversation: { findUnique: vi.fn(async (_q: any): Promise<any> => null) },
  emailJob: { findFirst: vi.fn(async (): Promise<any> => ({ record: { contactId: 'contact-1' } })) },
  recruiterBlastGroup: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  contact: { updateMany: vi.fn(async () => ({ count: 0 })) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const classifyStoredMessage = vi.fn(async (): Promise<any> => ({ intent: 'INTERESTED', confidence: 0.9 }));
vi.mock('@/lib/ai/context', () => ({ classifyStoredMessage }));
const triageReply = vi.fn();
vi.mock('@/lib/ai/triage', () => ({ triageReply }));
const dispatchWebhook = vi.fn(async () => undefined);
vi.mock('@/lib/webhooks/dispatch', () => ({ dispatchWebhook }));
vi.mock('@/lib/replyRules/apply', () => ({ applyReplyRules: vi.fn() }));
vi.mock('@/lib/email/ndr', () => ({
  applyDeliveryReport: vi.fn(async (): Promise<any[]> => [{ email: 'gone@corp.com', category: 'USER_UNKNOWN', decision: 'SUPPRESS' }]),
  willSuppress: (d: string) => d === 'SUPPRESS' || d === 'SUPPRESS_REPEAT',
}));

const { ingestInboundMessage } = await import('@/lib/gmail/ingest');
const { applyDeliveryReport } = await import('@/lib/email/ndr');
const { normalizeMessageId, messageIdVariants, groupCrossMailboxDuplicates, mergeBlockers } = await import('@/lib/gmail/dedupe');

const mailboxB = { id: 'acc-b', emailAddress: 'shreya@masaischool.com', workspaceId: 'w1', organizationId: 'org1', userId: 'u2' };

function msg(over: Record<string, unknown> = {}) {
  return {
    gmailMessageId: 'g-b',
    gmailThreadId: 'thread-b',
    labelIds: ['INBOX'],
    snippet: 'Interested',
    receivedAt: new Date('2026-11-13T10:00:00Z'),
    sentAt: new Date('2026-11-13T10:00:00Z'),
    from: { email: 'piyush@corp.com', name: 'Piyush' },
    to: [{ email: 'placementops@masaischool.com', name: null }],
    cc: [{ email: 'placements@masaischool.com', name: null }],
    subject: 'Re: Hiring partners',
    messageIdHeader: '<CAG7V8@mail.gmail.com>',
    inReplyTo: '<sent-1@masaischool.com>',
    references: '<sent-1@masaischool.com>',
    htmlBody: null,
    plainTextBody: 'Interested',
    attachments: [],
    headers: {},
    ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.conversationMessage.findFirst.mockResolvedValue(null);
  db.conversation.findUnique.mockResolvedValue(null);
});

describe('cross-mailbox duplicate inbound', () => {
  it('stores a fresh message and looks only in the same workspace, other mailboxes, inbound', async () => {
    const out = await ingestInboundMessage(mailboxB, msg());
    expect(out.status).toBe('STORED');
    const where = tx.conversationMessage.findFirst.mock.calls[0]![0].where;
    expect(where).toMatchObject({ direction: 'INBOUND', conversation: { workspaceId: 'w1', emailProviderAccountId: { not: 'acc-b' } } });
    expect(where.messageIdHeader.in).toEqual(expect.arrayContaining(['<CAG7V8@mail.gmail.com>', 'CAG7V8@mail.gmail.com', '<cag7v8@mail.gmail.com>']));
  });

  it('does not store a second copy, and does not notify, triage or call the webhook', async () => {
    tx.conversationMessage.findFirst.mockResolvedValue({ id: 'msg-a', conversationId: 'c-a' });
    const out = await ingestInboundMessage(mailboxB, msg());
    expect(out).toEqual({ status: 'DUPLICATE_OTHER_MAILBOX', messageId: 'msg-a', conversationId: 'c-a' });
    expect(tx.conversation.create).not.toHaveBeenCalled();
    expect(tx.conversationMessage.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(tx.recipientHistory.create).not.toHaveBeenCalled();
    expect(classifyStoredMessage).not.toHaveBeenCalled();
    expect(triageReply).not.toHaveBeenCalled();
    expect(dispatchWebhook).not.toHaveBeenCalled();
  });

  it('a different workspace is a different inbox: both are stored (the lookup is scoped to the workspace)', async () => {
    // The database answers "nothing" for workspace w9, which is what the scoped query returns.
    await ingestInboundMessage({ ...mailboxB, workspaceId: 'w9' }, msg());
    expect(tx.conversationMessage.findFirst.mock.calls[0]![0].where.conversation.workspaceId).toBe('w9');
    expect(tx.conversationMessage.create).toHaveBeenCalledTimes(1);
  });

  it('the same mailbox is excluded from the lookup (its own gmailMessageId check handles that)', async () => {
    await ingestInboundMessage(mailboxB, msg());
    expect(tx.conversationMessage.findFirst.mock.calls[0]![0].where.conversation.emailProviderAccountId).toEqual({ not: 'acc-b' });
    expect(db.conversationMessage.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { gmailMessageId: 'g-b' } }));
  });

  it('a message with no Message-ID is stored without a lookup', async () => {
    const out = await ingestInboundMessage(mailboxB, msg({ messageIdHeader: null }));
    expect(out.status).toBe('STORED');
    expect(tx.conversationMessage.findFirst).not.toHaveBeenCalled();
  });

  it('outbound messages are never deduplicated', async () => {
    db.conversation.findUnique.mockResolvedValue({ id: 'c-t', contactId: 'contact-1', recipientEmail: 'x@y.com' });
    const out = await ingestInboundMessage(mailboxB, msg({ from: { email: 'shreya@masaischool.com', name: 'S' }, labelIds: ['SENT'] }));
    expect(out.status).toBe('STORED');
    expect(tx.conversationMessage.findFirst).not.toHaveBeenCalled();
  });

  it('a duplicate bounce notice still applies its suppression', async () => {
    db.conversation.findUnique.mockResolvedValue({ id: 'c-known', contactId: 'contact-1', workspaceId: 'w1', ownerId: 'u2', assigneeId: null, recruiterBlastId: null, recipientEmail: 'gone@corp.com' });
    tx.conversationMessage.findFirst.mockResolvedValue({ id: 'msg-a', conversationId: 'c-a' });
    const out = await ingestInboundMessage(
      mailboxB,
      msg({ from: { email: 'mailer-daemon@googlemail.com', name: null }, subject: 'Delivery Status Notification (Failure)' }),
    );
    expect(applyDeliveryReport).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('DUPLICATE_OTHER_MAILBOX');
    expect(tx.conversationMessage.create).not.toHaveBeenCalled();
  });
});

describe('Message-ID helpers', () => {
  it('normalises case, brackets and whitespace', () => {
    expect(normalizeMessageId('  <AbC@Mail.Gmail.com> ')).toBe('abc@mail.gmail.com');
    expect(normalizeMessageId('abc@mail.gmail.com')).toBe('abc@mail.gmail.com');
    expect(normalizeMessageId(null)).toBe('');
    expect(messageIdHeader_empty()).toEqual([]);
  });
  function messageIdHeader_empty() {
    return messageIdVariants('   ');
  }
});

describe('duplicate grouping (cleanup script)', () => {
  const row = (conversationId: string, mailboxId: string, header: string | null, createdAt: string, workspaceId = 'w1') => ({
    conversationId, mailboxId, workspaceId, messageIdHeader: header, createdAt: new Date(createdAt),
  });

  it('groups the same email across mailboxes of one workspace, oldest first', () => {
    const groups = groupCrossMailboxDuplicates([
      row('late', 'm2', '<X@y>', '2026-11-13T10:05:00Z'),
      row('early', 'm1', 'x@Y', '2026-11-13T10:00:00Z'),
      row('other', 'm1', '<z@y>', '2026-11-13T10:00:00Z'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((r) => r.conversationId)).toEqual(['early', 'late']);
  });

  it('ignores other workspaces, a single mailbox, and messages without a Message-ID', () => {
    expect(groupCrossMailboxDuplicates([row('a', 'm1', '<x@y>', '2026-11-13T10:00:00Z', 'w1'), row('b', 'm2', '<x@y>', '2026-11-13T10:00:00Z', 'w2')])).toEqual([]);
    expect(groupCrossMailboxDuplicates([row('a', 'm1', '<x@y>', '2026-11-13T10:00:00Z'), row('b', 'm1', '<x@y>', '2026-11-13T10:01:00Z')])).toEqual([]);
    expect(groupCrossMailboxDuplicates([row('a', 'm1', null, '2026-11-13T10:00:00Z'), row('b', 'm2', '', '2026-11-13T10:00:00Z')])).toEqual([]);
  });

  it('only a one-message conversation with nothing of its own is a pure duplicate', () => {
    const pure = { inboundCount: 1, outboundCount: 0, notes: 0, tags: 0, followUps: 0, scheduledReplies: 0, assigneeId: null };
    expect(mergeBlockers(pure)).toEqual([]);
    expect(mergeBlockers({ ...pure, outboundCount: 1 })).toHaveLength(1);
    expect(mergeBlockers({ ...pure, notes: 1, tags: 2, followUps: 1, assigneeId: 'u1' })).toHaveLength(4);
    expect(mergeBlockers({ ...pure, inboundCount: 2 })).toHaveLength(1);
  });
});
