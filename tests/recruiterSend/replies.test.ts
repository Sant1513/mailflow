import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Replies to a Recruiter Bulk Send belong to the admin who sent it — their workspace, assigned to
 * them — not to the owner of the (possibly backup) mailbox that carried it. With BCC every
 * recruiter answers in the SAME Gmail thread, so each recruiter gets their own conversation.
 */
const created: any[] = [];
const notifications: any[] = [];
const tx = {
  conversation: {
    create: vi.fn(async ({ data }: any) => {
      const c = { id: `c${created.length + 1}`, assigneeId: null, recruiterBlastId: null, ...data };
      created.push(c);
      return c;
    }),
    update: vi.fn(),
  },
  conversationMessage: { create: vi.fn(async () => ({ id: 'msg1' })) },
  record: { updateMany: vi.fn() },
  recipientHistory: { create: vi.fn() },
  notification: { create: vi.fn(async ({ data }: any) => notifications.push(data)) },
};
const db = {
  conversationMessage: { findUnique: vi.fn(async () => null) },
  conversation: { findUnique: vi.fn(async (_q: any): Promise<any> => null) },
  emailJob: { findFirst: vi.fn(async () => null) },
  recruiterBlastGroup: { findFirst: vi.fn(), findMany: vi.fn() },
  recruiterBlastRecipient: { updateMany: vi.fn(async () => ({ count: 1 })) },
  contact: { upsert: vi.fn(async () => ({ id: 'contact-r' })) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/ai/context', () => ({ classifyStoredMessage: vi.fn(async () => null) }));
vi.mock('@/lib/ai/triage', () => ({ triageReply: vi.fn() }));
vi.mock('@/lib/webhooks/dispatch', () => ({ dispatchWebhook: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/bounces', () => ({ suppressBounced: vi.fn(async () => undefined) }));
vi.mock('@/lib/replyRules/apply', () => ({ applyReplyRules: vi.fn() }));

const { ingestInboundMessage } = await import('@/lib/gmail/ingest');
const { gmailThreadOf, recruiterThreadKey } = await import('@/lib/recruiterSend/replies');
const { suppressBounced } = await import('@/lib/email/bounces');

// A teammate's backup mailbox carried the send; the admin (u-admin, workspace w-admin) made it.
const mailbox = { id: 'acc-backup', emailAddress: 'backup@masaischool.com', workspaceId: 'w-teammate', organizationId: 'org1', userId: 'u-teammate' };
const blast = { id: 'b1', organizationId: 'org1', workspaceId: 'w-admin', createdById: 'u-admin' };

function reply(from: string, over: Record<string, unknown> = {}) {
  return {
    gmailMessageId: `g-${from}`,
    gmailThreadId: 'thread-1',
    labelIds: ['INBOX'],
    snippet: 'Interested, please share profiles',
    receivedAt: new Date('2026-11-04T10:00:00Z'),
    sentAt: new Date('2026-11-04T10:00:00Z'),
    from: { email: from, name: 'Priya' },
    to: [{ email: 'placements@masaischool.com', name: null }],
    cc: [],
    subject: 'Re: Hiring partners',
    messageIdHeader: `<${from}>`,
    inReplyTo: '<sent-1@masaischool.com>',
    references: '<sent-1@masaischool.com>',
    htmlBody: null,
    plainTextBody: 'Interested, please share profiles',
    attachments: [],
    headers: {},
    ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  notifications.length = 0;
  db.recruiterBlastGroup.findFirst.mockResolvedValue({ blast });
});

describe('recruiter replies', () => {
  it("open a conversation in the admin's workspace, assigned to the admin, not the mailbox owner", async () => {
    const out = await ingestInboundMessage(mailbox, reply('priya@corp.com'));
    expect(out.status).toBe('STORED');
    expect(created[0]).toMatchObject({
      workspaceId: 'w-admin',
      ownerId: 'u-admin',
      assigneeId: 'u-admin',
      recruiterBlastId: 'b1',
      emailProviderAccountId: 'acc-backup',
      recipientEmail: 'priya@corp.com',
      gmailThreadId: 'thread-1#priya@corp.com',
    });
    expect(db.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId_primaryEmail: { workspaceId: 'w-admin', primaryEmail: 'priya@corp.com' } } }));
    expect(notifications[0]).toMatchObject({ workspaceId: 'w-admin', userId: 'u-admin' });
    expect(db.recruiterBlastRecipient.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ blastId: 'b1', email: 'priya@corp.com' }) }));
  });

  it('recognises replies that arrive at the Reply-To mailbox, not only the sending one', async () => {
    const replyToMailbox = { ...mailbox, id: 'acc-admin', emailAddress: 'admin@masaischool.com', workspaceId: 'w-admin', userId: 'u-admin' };
    await ingestInboundMessage(replyToMailbox, reply('priya@corp.com', { gmailThreadId: 'admin-thread-9' }));
    const where = db.recruiterBlastGroup.findFirst.mock.calls[0]?.[0]?.where;
    // Message-ID match across the organization; thread match only within the receiving mailbox.
    expect(where.OR).toEqual([
      { messageIdHeader: { in: ['<sent-1@masaischool.com>', '<sent-1@masaischool.com>'] }, blast: { organizationId: 'org1' } },
      { gmailThreadId: 'admin-thread-9', accountId: 'acc-admin' },
    ]);
    expect(created[0]).toMatchObject({ workspaceId: 'w-admin', assigneeId: 'u-admin', emailProviderAccountId: 'acc-admin', gmailThreadId: 'admin-thread-9#priya@corp.com' });
  });

  it('gives each recruiter in the same BCC thread their own conversation', async () => {
    await ingestInboundMessage(mailbox, reply('priya@corp.com'));
    await ingestInboundMessage(mailbox, reply('rahul@agency.in'));
    expect(created.map((c) => c.gmailThreadId)).toEqual(['thread-1#priya@corp.com', 'thread-1#rahul@agency.in']);
    expect(created.map((c) => c.recipientEmail)).toEqual(['priya@corp.com', 'rahul@agency.in']);
  });

  it("adds a recruiter's later message to their existing conversation", async () => {
    db.conversation.findUnique.mockImplementation(async ({ where }: any) =>
      where.emailProviderAccountId_gmailThreadId.gmailThreadId === 'thread-1#priya@corp.com'
        ? { id: 'c-existing', contactId: 'contact-r', workspaceId: 'w-admin', ownerId: 'u-admin', assigneeId: 'u-admin', recruiterBlastId: 'b1', recipientEmail: 'priya@corp.com' }
        : null,
    );
    const out = await ingestInboundMessage(mailbox, reply('priya@corp.com', { gmailMessageId: 'g2', inReplyTo: null, references: null }));
    expect(out).toMatchObject({ status: 'STORED', conversationId: 'c-existing', created: false });
    expect(created).toHaveLength(0);
    expect(notifications[0]).toMatchObject({ workspaceId: 'w-admin', userId: 'u-admin' });
    db.conversation.findUnique.mockReset().mockResolvedValue(null);
  });

  it("doesn't open conversations for out-of-office answers", async () => {
    const out = await ingestInboundMessage(mailbox, reply('ooo@corp.com', { headers: { 'auto-submitted': 'auto-replied' }, subject: 'Out of office' }));
    expect(out.status).toBe('IGNORED');
    expect(created).toHaveLength(0);
  });

  it("suppresses bounced addresses in the admin's workspace instead of opening a conversation", async () => {
    const out = await ingestInboundMessage(mailbox, reply('mailer-daemon@googlemail.com', { subject: 'Delivery Status Notification (Failure)' }));
    expect(out.status).toBe('IGNORED');
    expect(created).toHaveLength(0);
    expect(suppressBounced).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w-admin' }));
  });

  it('leaves unrelated mail alone', async () => {
    db.recruiterBlastGroup.findFirst.mockResolvedValue(null);
    const out = await ingestInboundMessage(mailbox, reply('friend@gmail.com', { inReplyTo: null, references: null }));
    expect(out.status).toBe('IGNORED');
  });

  it('replies go back into the real Gmail thread', () => {
    expect(gmailThreadOf(recruiterThreadKey('18c2f0a', 'Priya@Corp.com'))).toBe('18c2f0a');
    expect(gmailThreadOf('18c2f0a')).toBe('18c2f0a');
    expect(gmailThreadOf(null)).toBeNull();
  });
});
