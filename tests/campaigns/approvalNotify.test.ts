import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Approval notifications no longer flood Gmail: requests and decisions are always in the app, and by email either ONE summary
 * (default) or nothing; the old "an email per request and per decision" stays as a choice.
 */
const db = {
  campaign: { findUnique: vi.fn(), findMany: vi.fn(async (_q: any): Promise<any[]> => []), update: vi.fn(async (_q: any) => ({})) },
  user: { findMany: vi.fn(async (_q: any): Promise<any[]> => []), count: vi.fn(async () => 2) },
  notification: { createMany: vi.fn(async (_q: any) => ({ count: 0 })), create: vi.fn(async (_q: any) => ({})) },
  emailProviderAccount: { findUnique: vi.fn(async (_q: any): Promise<any> => null) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/audit/log', () => ({ audit: vi.fn(async () => undefined) }));
const sendEmail = vi.fn(async (_i: any) => ({ threadId: 't1', messageIdHeader: '<m@x>' }));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class { sendEmail(i: any) { return sendEmail(i); } } }));
vi.mock('@/lib/app-url', () => ({ appBaseUrl: () => 'https://mail.test' }));

let settings: any = { approvals: { notify: 'DIGEST', digestMinutes: 60, lastDigestAt: null, lastDigestIds: [] }, senderAccountId: null };
const updateOrgSettings = vi.fn(async (_org: string, patch: any, _by?: string) => { settings = { ...settings, approvals: { ...settings.approvals, ...patch.approvals } }; return settings; });
vi.mock('@/lib/settings/org', () => ({ getOrgSettings: vi.fn(async () => settings), updateOrgSettings: (org: string, patch: any, by?: string) => updateOrgSettings(org, patch, by) }));
const sendSystemEmail = vi.fn(async (_o: any): Promise<string> => 'SENT to 2 from sender@masaischool.com');
vi.mock('@/lib/notify/system', () => ({ sendSystemEmail: (o: any) => sendSystemEmail(o), emailsForRoles: vi.fn(async () => ['a@masaischool.com', 'b@masaischool.com']) }));

const { digestDue, renderApprovalDigest, sendApprovalDigest } = await import('@/lib/campaigns/approvalDigest');
const { sendApprovalRequestEmail, sendApprovalDecisionEmail } = await import('@/lib/campaigns/approvalEmails');

const NOW = new Date('2026-11-25T10:00:00Z');
const session: any = { userId: 'rev', organizationId: 'o1', workspaceId: 'w9', homeWorkspaceId: 'w9', role: 'SUPER_ADMIN', email: 'rev@masaischool.com', name: 'Reviewer' };

beforeEach(() => {
  vi.clearAllMocks();
  settings = { approvals: { notify: 'DIGEST', digestMinutes: 60, lastDigestAt: null, lastDigestIds: [] }, senderAccountId: null };
  db.user.findMany.mockResolvedValue([{ id: 'a1', email: 'a@masaischool.com', ownedWorkspaces: [{ id: 'wa1' }] }, { id: 'a2', email: 'b@masaischool.com', ownedWorkspaces: [{ id: 'wa2' }] }]);
});

describe('when a summary email is due', () => {
  const base = { notify: 'DIGEST', digestMinutes: 60, lastDigestAt: null as string | null, lastDigestIds: [] as string[], pendingIds: ['c1'], now: NOW };
  it('the first request sends one', () => expect(digestDue(base)).toMatchObject({ send: true }));
  it('never when summaries are off, or nothing is waiting', () => {
    expect(digestDue({ ...base, notify: 'IN_APP' }).send).toBe(false);
    expect(digestDue({ ...base, notify: 'EMAIL' }).send).toBe(false);
    expect(digestDue({ ...base, pendingIds: [] }).send).toBe(false);
  });
  it('not again until the interval has passed, even with new requests', () => {
    const justNow = new Date(NOW.getTime() - 20 * 60_000).toISOString();
    expect(digestDue({ ...base, lastDigestAt: justNow, lastDigestIds: ['c0'], pendingIds: ['c0', 'c1'] })).toMatchObject({ send: false, reason: 'too soon after the last summary' });
  });
  it('after the interval, only when something new is waiting', () => {
    const hourAgo = new Date(NOW.getTime() - 61 * 60_000).toISOString();
    expect(digestDue({ ...base, lastDigestAt: hourAgo, lastDigestIds: ['c1'], pendingIds: ['c1'] }).send).toBe(false);
    expect(digestDue({ ...base, lastDigestAt: hourAgo, lastDigestIds: ['c1'], pendingIds: ['c1', 'c2'] }).send).toBe(true);
  });
  it('a daily reminder when the same requests are still waiting after a day', () => {
    const dayAgo = new Date(NOW.getTime() - 25 * 3600_000).toISOString();
    expect(digestDue({ ...base, lastDigestAt: dayAgo, lastDigestIds: ['c1'], pendingIds: ['c1'] })).toMatchObject({ send: true, reason: expect.stringMatching(/reminder/) });
  });
});

describe('the summary email', () => {
  it('lists every waiting campaign with who asked, how many people and how long, and links to Approvals', () => {
    const { subject, html } = renderApprovalDigest([
      { id: 'c1', name: 'Drive invite <1>', requester: 'Mannan', recipients: 7, waitingMinutes: 5 },
      { id: 'c2', name: 'Follow-up', requester: 'Asha', recipients: 26, waitingMinutes: 190 },
    ]);
    expect(subject).toBe('[MailFlow] 2 campaigns waiting for approval');
    expect(html).toContain('Drive invite &lt;1&gt;');
    expect(html).toContain('https://mail.test/campaigns/c1');
    expect(html).toContain('https://mail.test/approvals');
    expect(html).toMatch(/3 h/);
  });
  it('is singular for one', () => {
    expect(renderApprovalDigest([{ id: 'c1', name: 'X', requester: 'Y', recipients: 1, waitingMinutes: 1 }]).subject).toBe('[MailFlow] 1 campaign waiting for approval');
  });
});

describe('sending the summary', () => {
  const waiting = (ids: string[]) => ids.map((id) => ({ id, name: `Camp ${id}`, submittedAt: new Date(NOW.getTime() - 600_000), createdAt: new Date(NOW.getTime() - 600_000), createdBy: { name: 'Mannan' }, _count: { campaignRecords: 7 } }));
  it('sends ONE email to all approvers (visible To) and remembers what it listed', async () => {
    db.campaign.findMany.mockResolvedValue(waiting(['c1', 'c2', 'c3']));
    const r = await sendApprovalDigest('o1', NOW);
    expect(r).toMatchObject({ sent: true, pending: 3 });
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
    expect(sendSystemEmail.mock.calls[0]![0]).toMatchObject({ to: ['a@masaischool.com', 'b@masaischool.com'], visible: true });
    expect(settings.approvals.lastDigestIds).toEqual(['c1', 'c2', 'c3']);
    expect(settings.approvals.lastDigestAt).toBe(NOW.toISOString());
  });
  it('a second run a minute later sends nothing', async () => {
    db.campaign.findMany.mockResolvedValue(waiting(['c1']));
    await sendApprovalDigest('o1', NOW);
    const again = await sendApprovalDigest('o1', new Date(NOW.getTime() + 60_000));
    expect(again.sent).toBe(false);
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
  });
  it('if the email does not go out, the slot is given back so the next run tries again', async () => {
    db.campaign.findMany.mockResolvedValue(waiting(['c1']));
    sendSystemEmail.mockResolvedValueOnce('FAILED: Gmail down');
    const r = await sendApprovalDigest('o1', NOW);
    expect(r.sent).toBe(false);
    expect(settings.approvals.lastDigestAt).toBeNull();
    expect(settings.approvals.lastDigestIds).toEqual([]);
  });
  it('does nothing in the other modes', async () => {
    settings.approvals.notify = 'IN_APP';
    expect((await sendApprovalDigest('o1', NOW)).sent).toBe(false);
    expect(db.campaign.findMany).not.toHaveBeenCalled();
  });
});

describe('a request and its decision', () => {
  const campaign = {
    id: 'c1', name: 'Drive invite', organizationId: 'o1', workspaceId: 'w1', createdById: 'req', approvalRequestAccountId: null, approvalRequestMessageId: null, approvalRequestThreadId: null,
    workspace: { name: 'W' }, dataset: { name: 'D' }, template: { name: 'T' }, templateVersion: { version: 1, subject: 'S' }, createdBy: { id: 'req', name: 'Mannan', email: 'mannan@masaischool.com' }, _count: { campaignRecords: 7 }, documents: [],
  };
  beforeEach(() => db.campaign.findUnique.mockResolvedValue(campaign));

  it('summary mode: approvers get it in the app, nobody gets an email', async () => {
    const status = await sendApprovalRequestEmail('c1', session);
    expect(status).toMatch(/^NOT EMAILED: shown in the app; one summary email at most every 60 min/);
    expect(sendEmail).not.toHaveBeenCalled();
    const rows = db.notification.createMany.mock.calls[0]![0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: 'APPROVAL_REQUESTED', link: '/approvals', workspaceId: 'wa1', userId: 'a1' });
  });
  it('in-app-only mode says so', async () => {
    settings.approvals.notify = 'IN_APP';
    expect(await sendApprovalRequestEmail('c1', session)).toBe('NOT EMAILED: shown in the app only');
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it('the old way still emails every approver, and also shows in the app', async () => {
    settings.approvals.notify = 'EMAIL';
    db.emailProviderAccount.findUnique.mockResolvedValue({ id: 'mb1', status: 'CONNECTED', emailAddress: 'mannan@masaischool.com', displayName: 'Mannan' });
    const status = await sendApprovalRequestEmail('c1', session);
    expect(status).toMatch(/^SENT to/);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(db.notification.createMany).toHaveBeenCalledTimes(1);
  });
  it('a decision is in the requester’s notifications, with no email in summary or in-app mode', async () => {
    const status = await sendApprovalDecisionEmail('c1', 'REJECTED', session, 'Wrong list');
    expect(status).toMatch(/^NOT EMAILED/);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.notification.create.mock.calls[0]![0].data).toMatchObject({ userId: 'req', workspaceId: 'w1', type: 'APPROVAL_DECIDED', title: 'Rejected: Drive invite', body: 'Reason: Wrong list', link: '/campaigns/c1' });
  });
  it('a failing notification never stops the request', async () => {
    db.notification.createMany.mockRejectedValueOnce(new Error('db'));
    await expect(sendApprovalRequestEmail('c1', session)).resolves.toMatch(/^NOT EMAILED/);
  });
});
