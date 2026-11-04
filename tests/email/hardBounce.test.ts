import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A permanent bounce from any tool and any user: the address goes on the suppression list of
 * every workspace in the organization, with the reason — so no teammate's campaign, Quick Send
 * or Recruiter Bulk Send mails it again.
 */
const db = {
  workspace: {
    findUnique: vi.fn(async () => ({ organizationId: 'org1' })),
    findMany: vi.fn(async () => [{ id: 'w2' }, { id: 'w3' }]),
  },
  emailSuppression: { upsert: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 2 })) },
  record: { updateMany: vi.fn(async () => ({ count: 1 })) },
  emailJob: { findFirst: vi.fn(async () => ({ campaignId: 'c9' })) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const dispatchWebhook = vi.fn(async () => undefined);
vi.mock('@/lib/webhooks/dispatch', () => ({ dispatchWebhook }));

const { recordHardBounce, suppressBounced } = await import('@/lib/email/bounces');

beforeEach(() => vi.clearAllMocks());

describe('hard bounces', () => {
  it("suppress in the sender's workspace with the reason and campaign, and in every other workspace of the organization", async () => {
    await recordHardBounce({ workspaceId: 'w1', email: 'Gone@Corp.com', detail: 'Gmail rejected the address when sending (INVALID_RECIPIENT): no such user', campaignId: 'c1' });
    expect(db.emailSuppression.upsert).toHaveBeenCalledWith({
      where: { workspaceId_email: { workspaceId: 'w1', email: 'gone@corp.com' } },
      create: expect.objectContaining({ workspaceId: 'w1', email: 'gone@corp.com', source: 'BOUNCE', reason: 'BOUNCED', campaignId: 'c1', detail: expect.stringContaining('no such user') }),
      update: {}, // an unsubscribe or manual entry is kept as it is
    });
    expect(db.workspace.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org1', id: { not: 'w1' } } }));
    const many = (db.emailSuppression.createMany.mock.calls[0] as any[])[0];
    expect(many.skipDuplicates).toBe(true);
    expect(many.data.map((d: any) => d.workspaceId)).toEqual(['w2', 'w3']);
    expect(many.data[0].detail).toContain("bounced on a teammate's send");
    expect(db.record.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ emailStatus: 'BOUNCED' }) }));
    expect(dispatchWebhook).toHaveBeenCalledWith('w1', 'email.bounced', expect.objectContaining({ email: 'gone@corp.com' }));
  });

  it('a bounce notice (any tool) is recorded through the same path, labelled with where it came from', async () => {
    const out = await suppressBounced({
      workspaceId: 'w1',
      conversationRecipient: null,
      ownAddresses: ['me@masaischool.com'],
      label: 'Bounce notice (Recruiter Bulk Send “Hiring partners”)',
      message: { subject: 'Delivery Status Notification (Failure)', plainTextBody: "Address not found\nYour message wasn't delivered to gone@corp.com because the address couldn't be found. 550 5.1.1", htmlBody: null },
    });
    expect(out).toEqual(['gone@corp.com']);
    const create = (db.emailSuppression.upsert.mock.calls[0] as any[])[0].create;
    expect(create.detail).toMatch(/^Bounce notice \(Recruiter Bulk Send “Hiring partners”\): /);
    expect(db.emailSuppression.createMany).toHaveBeenCalled();
  });

  it('temporary problems (mailbox full) suppress nothing', async () => {
    const out = await suppressBounced({
      workspaceId: 'w1',
      conversationRecipient: 'full@corp.com',
      ownAddresses: [],
      message: { subject: 'Delivery delayed', plainTextBody: 'Mailbox full. 452 4.2.2 will retry', htmlBody: null },
    });
    expect(out).toEqual([]);
    expect(db.emailSuppression.upsert).not.toHaveBeenCalled();
  });
});
