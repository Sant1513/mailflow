import { describe, expect, it, vi } from 'vitest';

/**
 * Quick Send follow-up type: "individual new email" plans every person as a fresh email from the sender (no earlier
 * thread, no waiting for the original mailbox); the default still replies in each person's thread.
 */
const db = {
  emailJob: { findMany: vi.fn(async () => [{ id: 'j1', toEmail: 'a@corp.com', emailProviderAccountId: 'a9', gmailThreadId: 'T1', messageIdHeader: '<m1@x>' }]) },
  emailProviderAccount: { findMany: vi.fn(async () => [{ id: 'a9', emailAddress: 'orig@masaischool.com', displayName: null, status: 'CONNECTED' }]) },
  campaign: { findMany: vi.fn(async () => []) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/campaigns/fallback', () => ({ fallbackOptIns: vi.fn(async () => new Set(['a9'])) }));

const { planFollowUpJobs } = await import('@/lib/quickSend/followUp');
const sender = { id: 'me', emailAddress: 'me@masaischool.com', displayName: null };

describe('planFollowUpJobs type', () => {
  it('NEW: everyone is a new email from the sender, nothing is looked up or waited for', async () => {
    const plans = await planFollowUpJobs({ rootCampaignId: 'c1', organizationId: 'o1', onMailboxDown: 'WAIT', mode: 'NEW', sender, emails: ['A@corp.com', 'b@corp.com'] });
    expect([...plans.keys()].sort()).toEqual(['a@corp.com', 'b@corp.com']);
    for (const p of plans.values()) expect(p).toMatchObject({ accountId: 'me', replyThreadId: null, inReplyToJobId: null, blockedBy: null });
    expect(db.emailJob.findMany).not.toHaveBeenCalled();
  });
});
