import { describe, it, expect, vi } from 'vitest';

// The module imports prisma/GmailProvider for the senders; the pure helpers
// under test never touch them, but the imports must resolve.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));

const { approvalRequestSubject, renderApprovalRequest, renderApprovalDecision, pickDecisionMailbox, appUrl } = await import('@/lib/campaigns/approvalEmails');

const box = (id: string, status: string) => ({ id, status, emailAddress: `${id}@example.com` });

describe('approval email subjects and URLs', () => {
  it('uses one subject for the whole thread', () => {
    expect(approvalRequestSubject('RPG reminder')).toBe('[MailFlow] Approval requested: RPG reminder');
  });

  it('builds absolute review links from NEXTAUTH_URL', () => {
    const saved = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = 'https://mailflow.example/';
    expect(appUrl('/campaigns/c1')).toBe('https://mailflow.example/campaigns/c1');
    process.env.NEXTAUTH_URL = saved;
  });
});

describe('renderApprovalRequest', () => {
  const out = renderApprovalRequest({
    campaignName: 'Q3 <Placements>',
    requesterName: 'Rahul & Co',
    requesterEmail: 'rahul@masaischool.com',
    workspaceName: 'Placements',
    datasetName: 'Sept batch',
    recipientCount: 263,
    subjectLine: 'Reminder: {{Deadline}}',
    templateName: 'RPG v2',
    templateVersion: 3,
    reviewUrl: 'https://x/campaigns/c1',
  });

  it('includes every fact and escapes HTML', () => {
    expect(out.html).toContain('Q3 &lt;Placements&gt;');
    expect(out.html).toContain('Rahul &amp; Co');
    expect(out.html).toContain('263');
    expect(out.html).toContain('RPG v2 (v3)');
    expect(out.html).toContain('href="https://x/campaigns/c1"');
    expect(out.html).not.toContain('<Placements>');
  });

  it('has a plain-text alternative with the same facts', () => {
    expect(out.plainText).toContain('Q3 <Placements>');
    expect(out.plainText).toContain('263');
    expect(out.plainText).not.toContain('<td');
  });
});

describe('renderApprovalDecision', () => {
  it('approved: says who and links the campaign', () => {
    const out = renderApprovalDecision({ campaignName: 'C', decision: 'APPROVED', reviewerName: 'Admin', reviewUrl: 'https://x/c' });
    expect(out.html).toContain('approved');
    expect(out.html).toContain('Admin');
    expect(out.html).not.toContain('Reason');
  });

  it('rejected: carries the reason, escaped', () => {
    const out = renderApprovalDecision({ campaignName: 'C', decision: 'REJECTED', reviewerName: 'Admin', reason: 'Fix <subject>', reviewUrl: 'https://x/c' });
    expect(out.html).toContain('rejected');
    expect(out.html).toContain('Fix &lt;subject&gt;');
    expect(out.plainText).toContain('Reason: Fix <subject>');
  });
});

describe('pickDecisionMailbox', () => {
  it('prefers the reviewer\'s connected mailbox; sameThread only when it sent the request', () => {
    const r = pickDecisionMailbox({ reviewer: box('rev', 'CONNECTED'), requester: box('req', 'CONNECTED'), requestAccountId: 'req' });
    expect(r).toEqual({ account: box('rev', 'CONNECTED'), sameThread: false });
  });

  it('falls back to the requester\'s mailbox and reuses the Gmail thread', () => {
    const r = pickDecisionMailbox({ reviewer: box('rev', 'DISCONNECTED'), requester: box('req', 'CONNECTED'), requestAccountId: 'req' });
    expect(r).toEqual({ account: box('req', 'CONNECTED'), sameThread: true });
    expect(pickDecisionMailbox({ reviewer: null, requester: box('req', 'CONNECTED'), requestAccountId: 'req' })?.sameThread).toBe(true);
  });

  it('returns null when nobody has a connected mailbox', () => {
    expect(pickDecisionMailbox({ reviewer: box('rev', 'DISCONNECTED'), requester: null, requestAccountId: null })).toBeNull();
  });
});
