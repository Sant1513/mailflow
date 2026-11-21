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
  emailSuppression: { upsert: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 2 })), findFirst: vi.fn(async (): Promise<any> => null) },
  record: { updateMany: vi.fn(async () => ({ count: 1 })) },
  emailJob: { findFirst: vi.fn(async () => ({ campaignId: 'c9' })) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const dispatchWebhook = vi.fn(async () => undefined);
vi.mock('@/lib/webhooks/dispatch', () => ({ dispatchWebhook }));

const { recordHardBounce, suppressBounced } = await import('@/lib/email/bounces');
const { resetOrgScopeCache } = await import('@/lib/suppressions/scope');

beforeEach(() => { vi.clearAllMocks(); resetOrgScopeCache(); db.emailSuppression.findFirst.mockResolvedValue(null); });

describe('hard bounces', () => {
  it("is saved once, in the sender's workspace, with the reason and campaign (one shared list for the organisation, no copies)", async () => {
    await recordHardBounce({ workspaceId: 'w1', email: 'Gone@Corp.com', detail: 'Gmail rejected the address when sending (INVALID_RECIPIENT): no such user', campaignId: 'c1' });
    expect(db.emailSuppression.upsert).toHaveBeenCalledWith({
      where: { workspaceId_email: { workspaceId: 'w1', email: 'gone@corp.com' } },
      create: expect.objectContaining({ workspaceId: 'w1', email: 'gone@corp.com', source: 'BOUNCE', reason: 'BOUNCED', campaignId: 'c1', detail: expect.stringContaining('no such user') }),
      update: {}, // an unsubscribe or manual entry is kept as it is
    });
    expect(db.emailSuppression.createMany).not.toHaveBeenCalled(); // no copies in the other workspaces
    // It first looked across the whole organisation for an existing bounce of the same address.
    expect(db.emailSuppression.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ email: 'gone@corp.com', workspaceId: { in: expect.arrayContaining(['w1', 'w2', 'w3']) } }) }));
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
    expect(db.emailSuppression.createMany).not.toHaveBeenCalled();
  });

  it('an address a teammate already bounced is already blocked for everyone: nothing more is saved', async () => {
    db.emailSuppression.findFirst.mockResolvedValue({ id: 'existing' });
    await recordHardBounce({ workspaceId: 'w1', email: 'gone@corp.com', detail: 'no such user', campaignId: 'c1' });
    expect(db.emailSuppression.upsert).not.toHaveBeenCalled();
    expect(db.emailSuppression.createMany).not.toHaveBeenCalled();
    expect(db.record.updateMany).toHaveBeenCalled(); // the records are still marked bounced
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
