import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, rawToGmail } from '../fixtures/ndr/mime';

/**
 * Acting on delivery reports (lib/email/ndr.ts) and the backfill core (lib/email/ndrBackfill.ts):
 * which send a notice is about (Message-ID, thread, or failed address + this mailbox's recent
 * sends; the address inside a BCC group), and the rules — hard / policy / spam suppress at once,
 * a full mailbox on its second notice in 30 days, a delay never.
 */
const db = {
  emailJob: { findMany: vi.fn(async (_q: any): Promise<any[]> => []), updateMany: vi.fn(async () => ({ count: 1 })) },
  recruiterBlastGroup: { findMany: vi.fn(async (_q: any): Promise<any[]> => []) },
  recruiterBlastRecipient: { findMany: vi.fn(async (_q: any): Promise<any[]> => []), updateMany: vi.fn(async () => ({ count: 1 })) },
  softBounce: { count: vi.fn(async (_q: any) => 0), createMany: vi.fn(async () => ({ count: 1 })) },
  conversation: { findUnique: vi.fn(async (_q: any): Promise<any> => null) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const recordHardBounce = vi.fn(async (_input: any) => undefined);
vi.mock('@/lib/email/bounces', () => ({ recordHardBounce }));

const { planDeliveryReport, applyDeliveryReport, willSuppress } = await import('@/lib/email/ndr');
const { parseDeliveryReport } = await import('@/lib/email/dsn');
const { parseGmailMessage } = await import('@/lib/gmail/parseMessage');
const { processNotice, ndrSearchQuery } = await import('@/lib/email/ndrBackfill');

const account = { id: 'acc-1', emailAddress: 'placements.bcc@masaischool.com', workspaceId: 'w-mailbox', organizationId: 'org1' };
const receivedAt = new Date('2026-11-09T11:12:44Z');

const bccGroup = { id: 'grp-2', sentAt: new Date('2026-11-06T12:31:00Z'), blast: { id: 'blast-5nov', name: 'Recruiter send For Drive · 5 Nov 2026 Set 2', workspaceId: 'w-admin', mode: 'BCC' } };

function ctxFor(fixtureName: string, over: Record<string, unknown> = {}) {
  const message = parseGmailMessage(rawToGmail(fixture(fixtureName)));
  const report = parseDeliveryReport(message, [account.emailAddress, 'apollo.moirangthem@masaischool.com', 'placements@masaischool.com'])!;
  return { account, report, gmailMessageId: 'gm-ndr-1', gmailThreadId: 'th-ndr-1', receivedAt, conversation: null, ...over };
}

function textReport(body: string, subject = 'Delivery Status Notification (Failure)', refs: string | null = '<job-1@masaischool.com>') {
  return parseDeliveryReport({ subject, from: { email: 'mailer-daemon@googlemail.com', name: null }, headers: {}, plainTextBody: body, htmlBody: null, inReplyTo: refs, references: refs })!;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.emailJob.findMany.mockResolvedValue([]);
  db.recruiterBlastGroup.findMany.mockResolvedValue([]);
  db.recruiterBlastRecipient.findMany.mockResolvedValue([]);
  db.softBounce.count.mockResolvedValue(0);
  db.conversation.findUnique.mockResolvedValue(null);
});

describe('BCC recruiter send: Gmail "Message blocked" 452 4.7.1', () => {
  it('finds the recipient by address inside the BCC group the Message-ID points to, suppresses, and marks them bounced', async () => {
    db.recruiterBlastGroup.findMany.mockResolvedValue([bccGroup]);
    db.recruiterBlastRecipient.findMany.mockImplementation(async ({ where }: any) =>
      where.groupId?.in?.includes('grp-2') && where.OR?.[0]?.email?.in?.includes('jannat.t@healthfab.in') ? [{ id: 'rec-jannat', email: 'jannat.t@healthfab.in', groupId: 'grp-2' }] : [],
    );
    const ctx = ctxFor('gmail-message-blocked.eml');
    const actions = await applyDeliveryReport(ctx);

    // Matched by the Message-ID it answers, anywhere in the organization.
    const groupWhere = db.recruiterBlastGroup.findMany.mock.calls[0]![0].where;
    expect(groupWhere.OR[0]).toEqual({ messageIdHeader: { in: ['<CAKbcc-group-2-set2@mail.gmail.com>'] }, blast: { organizationId: 'org1' } });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ email: 'jannat.t@healthfab.in', category: 'POLICY_BLOCK', statusCode: '4.7.1', decision: 'SUPPRESS', workspaceId: 'w-admin' });
    expect(actions[0]!.send).toMatchObject({ kind: 'RECRUITER', blastId: 'blast-5nov', recipientId: 'rec-jannat', mode: 'BCC' });

    expect(recordHardBounce).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w-admin',
      email: 'jannat.t@healthfab.in',
      detail: '452 4.7.1 Mailbox delivery restricted by policy error',
      category: 'POLICY_BLOCK',
      statusCode: '4.7.1',
      recruiterBlastId: 'blast-5nov',
      reason: 'BOUNCED',
      remark: expect.stringContaining('Recruiter Bulk Send “Recruiter send For Drive · 5 Nov 2026 Set 2”'),
    }));
    expect(db.recruiterBlastRecipient.updateMany).toHaveBeenCalledWith({ where: { id: 'rec-jannat' }, data: { status: 'BOUNCED', skipReason: "Bounced: Blocked by the recipient's mail policy (4.7.1)" } });
  });
});

describe('individual recruiter copy: Office 365 NDR with no In-Reply-To', () => {
  it("matches by the failed address + this mailbox's sends in the last 14 days", async () => {
    db.recruiterBlastRecipient.findMany.mockImplementation(async ({ where }: any) =>
      where.group?.accountId === 'acc-1' && where.email?.in?.includes('thakurayush@atfenix.com')
        ? [{ id: 'rec-thakur', email: 'thakurayush@atfenix.com', groupId: 'grp-77', group: { sentAt: new Date('2026-11-12T06:40:50Z') }, blast: { id: 'blast-dec5', name: 'Recruiter Drive Campaign Dec Set 5 · 12 Nov 2026', workspaceId: 'w-admin', mode: 'INDIVIDUAL' } }]
        : [],
    );
    const ctx = ctxFor('o365-user-unknown.eml', { account: { ...account, emailAddress: 'apollo.moirangthem@masaischool.com' }, receivedAt: new Date('2026-11-12T06:41:09Z') });
    const actions = await applyDeliveryReport(ctx);
    const recentWhere = db.recruiterBlastRecipient.findMany.mock.calls.at(-1)![0].where;
    expect(recentWhere.group.sentAt.gte.toISOString()).toBe('2026-10-29T06:41:09.000Z');
    expect(actions[0]).toMatchObject({ email: 'thakurayush@atfenix.com', category: 'USER_UNKNOWN', statusCode: '5.1.10', decision: 'SUPPRESS' });
    expect(recordHardBounce).toHaveBeenCalledWith(expect.objectContaining({ email: 'thakurayush@atfenix.com', category: 'USER_UNKNOWN', recruiterBlastId: 'blast-dec5', workspaceId: 'w-admin' }));
    expect(db.recruiterBlastRecipient.updateMany).toHaveBeenCalledWith({ where: { id: 'rec-thakur' }, data: { status: 'BOUNCED', skipReason: "Bounced: Address doesn't exist (5.1.10)" } });
  });

  it('an individual copy (one recipient) the Message-ID points to is matched even when the notice names no address', async () => {
    db.recruiterBlastGroup.findMany.mockResolvedValue([{ ...bccGroup, id: 'grp-1', blast: { ...bccGroup.blast, mode: 'INDIVIDUAL' } }]);
    db.recruiterBlastRecipient.findMany.mockResolvedValue([{ id: 'rec-1', email: 'solo@corp.example', groupId: 'grp-1' }]);
    const actions = await planDeliveryReport({ ...ctxFor('o365-user-unknown.eml'), report: textReport('Delivery has failed. 550 5.1.1 user unknown', 'Undeliverable: hi') });
    expect(actions[0]).toMatchObject({ email: 'solo@corp.example', decision: 'SUPPRESS' });
  });
});

describe('campaign sends and the rules', () => {
  const job = { id: 'job-1', toEmail: 'Priya@Example.com', campaignId: 'camp-1', sentAt: new Date('2026-11-01T10:00:00Z'), campaign: { name: 'Nov Drive', workspaceId: 'w-camp' } };

  it('a campaign bounce marks the job BOUNCED (status stays SENT) with the reason', async () => {
    db.emailJob.findMany.mockImplementation(async ({ where }: any) => (where.messageIdHeader ? [job] : []));
    await applyDeliveryReport({ ...ctxFor('gmail-delay.eml'), report: textReport("Your message wasn't delivered to priya@example.com because the address couldn't be found.\n550 5.1.1 The email account that you tried to reach does not exist.") });
    expect(recordHardBounce).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w-camp', email: 'priya@example.com', campaignId: 'camp-1', category: 'USER_UNKNOWN' }));
    expect(db.emailJob.updateMany).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { errorCode: 'BOUNCED', errorMessage: expect.stringMatching(/^Bounced: Address doesn't exist \(5\.1\.1\)/) } });
  });

  it('mailbox full: the first notice is only counted; a second within 30 days suppresses', async () => {
    db.emailJob.findMany.mockImplementation(async ({ where }: any) => (where.messageIdHeader ? [job] : []));
    const report = textReport("Your message couldn't be delivered to priya@example.com.\nThe response from the remote server was:\n552 5.2.2 The email account that you tried to reach is over quota.");
    const first = await applyDeliveryReport({ ...ctxFor('gmail-delay.eml'), report });
    expect(first[0]!.decision).toBe('SOFT_FIRST');
    expect(recordHardBounce).not.toHaveBeenCalled();
    expect(db.softBounce.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ email: 'priya@example.com', category: 'MAILBOX_FULL', gmailMessageId: 'gm-ndr-1', organizationId: 'org1' })], skipDuplicates: true });
    const countWhere = db.softBounce.count.mock.calls[0]![0].where;
    expect(countWhere).toMatchObject({ organizationId: 'org1', email: 'priya@example.com', category: 'MAILBOX_FULL', NOT: { gmailMessageId: 'gm-ndr-1' } });

    db.softBounce.count.mockResolvedValue(1);
    const second = await applyDeliveryReport({ ...ctxFor('gmail-delay.eml'), report, gmailMessageId: 'gm-ndr-2' });
    expect(second[0]!.decision).toBe('SUPPRESS_REPEAT');
    expect(recordHardBounce).toHaveBeenCalledWith(expect.objectContaining({ email: 'priya@example.com', category: 'MAILBOX_FULL', remark: expect.stringContaining('second notice in 30 days') }));
  });

  it('a temporary delay is noted and never suppresses or marks the send', async () => {
    db.emailJob.findMany.mockImplementation(async ({ where }: any) => (where.messageIdHeader ? [{ ...job, toEmail: 'neha@slow.example.in' }] : []));
    const actions = await applyDeliveryReport(ctxFor('gmail-delay.eml'));
    expect(actions[0]).toMatchObject({ email: 'neha@slow.example.in', category: 'TEMPORARY', decision: 'NOTE' });
    expect(willSuppress(actions[0]!.decision)).toBe(false);
    expect(recordHardBounce).not.toHaveBeenCalled();
    expect(db.emailJob.updateMany).not.toHaveBeenCalled();
    expect(db.softBounce.createMany).toHaveBeenCalled();
  });

  it('message too large marks the send bounced without suppressing the address', async () => {
    db.emailJob.findMany.mockImplementation(async ({ where }: any) => (where.messageIdHeader ? [{ ...job, toEmail: 'big@corp.example' }] : []));
    const actions = await applyDeliveryReport({ ...ctxFor('gmail-delay.eml'), report: textReport('<big@corp.example>: host mx said: 552 5.3.4 Message size exceeds fixed maximum message size', 'Undelivered Mail Returned to Sender') });
    expect(actions[0]!.decision).toBe('MARK_ONLY');
    expect(recordHardBounce).not.toHaveBeenCalled();
    expect(db.emailJob.updateMany).toHaveBeenCalled();
  });

  it('a notice about mail MailFlow did not send is left alone', async () => {
    const actions = await applyDeliveryReport({ ...ctxFor('gmail-delay.eml'), report: textReport("Your message wasn't delivered to someone@else.example. 550 5.1.1", 'Delivery Status Notification (Failure)', null) });
    expect(actions[0]).toMatchObject({ email: 'someone@else.example', decision: 'NO_MATCH' });
    expect(recordHardBounce).not.toHaveBeenCalled();
    expect(db.softBounce.createMany).not.toHaveBeenCalled();
  });

  it("in a known conversation with no address in the notice, the conversation's recipient is used", async () => {
    const actions = await applyDeliveryReport({ ...ctxFor('gmail-delay.eml'), report: textReport('Delivery has failed. 550 5.1.1 user unknown', 'Undeliverable: hi', null), conversation: { workspaceId: 'w-conv', recipientEmail: 'student@college.example' } });
    expect(actions[0]).toMatchObject({ email: 'student@college.example', decision: 'SUPPRESS', workspaceId: 'w-conv' });
    expect(recordHardBounce).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w-conv', email: 'student@college.example' }));
  });

  it('a spam complaint suppresses with reason COMPLAINT', async () => {
    db.emailJob.findMany.mockImplementation(async ({ where }: any) => (where.messageIdHeader?.in?.includes('<job-8100@masaischool.com>') ? [{ ...job, toEmail: 'annoyed.user@yahoo.com' }] : []));
    const actions = await applyDeliveryReport(ctxFor('arf-complaint.eml'));
    expect(actions[0]).toMatchObject({ email: 'annoyed.user@yahoo.com', category: 'COMPLAINT', decision: 'SUPPRESS' });
    expect(recordHardBounce).toHaveBeenCalledWith(expect.objectContaining({ reason: 'COMPLAINT', category: 'COMPLAINT' }));
  });
});

describe('backfill core (scripts/backfill-ndr.ts)', () => {
  it('builds the Gmail search', () => {
    const q = ndrSearchQuery(30);
    expect(q).toContain('newer_than:30d');
    expect(q).toContain('from:(mailer-daemon OR postmaster)');
    expect(q).toContain('"message blocked"');
  });

  it('dry run plans without writing; --apply writes', async () => {
    db.recruiterBlastGroup.findMany.mockResolvedValue([bccGroup]);
    db.recruiterBlastRecipient.findMany.mockResolvedValue([{ id: 'rec-jannat', email: 'jannat.t@healthfab.in', groupId: 'grp-2' }]);
    const raw = rawToGmail(fixture('gmail-message-blocked.eml'), { id: 'gm-77', threadId: 'th-77' });

    const dry = await processNotice(account, raw, { apply: false });
    expect(dry.actions[0]).toMatchObject({ email: 'jannat.t@healthfab.in', category: 'POLICY_BLOCK', decision: 'SUPPRESS' });
    expect(recordHardBounce).not.toHaveBeenCalled();
    expect(db.recruiterBlastRecipient.updateMany).not.toHaveBeenCalled();
    expect(db.softBounce.createMany).not.toHaveBeenCalled();

    await processNotice(account, raw, { apply: true });
    expect(recordHardBounce).toHaveBeenCalledTimes(1);
    expect(db.recruiterBlastRecipient.updateMany).toHaveBeenCalledTimes(1);
  });

  it('leaves alone search hits that are not about MailFlow sends', async () => {
    const plain = rawToGmail('From: Friend <friend@shop.example>\nSubject: Lunch on Friday?\nContent-Type: text/plain\n\nAre you free?\n');
    expect((await processNotice(account, plain, { apply: true })).skipped).toMatch(/not a delivery report/);
    // A subject that merely looks like a notice: read, matches no send, nothing written.
    const lookalike = rawToGmail('From: Newsletter <news@shop.example>\nSubject: Returned mail policy update\nContent-Type: text/plain\n\nOur returns policy changed.\n');
    const r = await processNotice(account, lookalike, { apply: true });
    expect(r.actions.every((a) => a.decision === 'NO_MATCH')).toBe(true);
    expect(recordHardBounce).not.toHaveBeenCalled();
    expect(db.softBounce.createMany).not.toHaveBeenCalled();
  });
});
