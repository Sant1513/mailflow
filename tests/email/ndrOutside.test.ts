import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { outsideMailFlow } = await import('@/lib/email/ndrBackfill');

/** --include-outside: hard bounces on emails sent outside MailFlow are suppressed; soft ones and our own domains never. */
const account = { emailAddress: 'apollo@masaischool.com', workspaceId: 'w-apollo' };
const base = { email: 'pmishra@easterncargo.co.in', category: 'USER_UNKNOWN', statusCode: '5.1.1', remark: "Address doesn't exist", diagnostic: '550 5.1.1', decision: 'NO_MATCH', workspaceId: null, organizationId: 'o1', send: null, sourceLabel: 'Bounce notice' } as any;
const own = ['masaischool.com', 'neevlabs.ai'];

describe('outsideMailFlow', () => {
  it('suppresses a hard bounce in the mailbox owner’s workspace', () => {
    const a = outsideMailFlow(base, account, own);
    expect(a.decision).toBe('SUPPRESS');
    expect(a.workspaceId).toBe('w-apollo');
    expect(a.sourceLabel).toContain('outside MailFlow from apollo@masaischool.com');
  });
  it('also policy and spam blocks', () => {
    expect(outsideMailFlow({ ...base, category: 'POLICY_BLOCK' }, account, own).decision).toBe('SUPPRESS');
    expect(outsideMailFlow({ ...base, category: 'SPAM_BLOCK' }, account, own).decision).toBe('SUPPRESS');
  });
  it('never delays, full mailboxes or too-large messages', () => {
    for (const category of ['TEMPORARY', 'MAILBOX_FULL', 'MESSAGE_TOO_LARGE']) expect(outsideMailFlow({ ...base, category }, account, own).decision).toBe('NO_MATCH');
  });
  it('never our own domains, the mailbox itself, or a notice with no address', () => {
    expect(outsideMailFlow({ ...base, email: 'someone@masaischool.com' }, account, own).decision).toBe('NO_MATCH');
    expect(outsideMailFlow({ ...base, email: 'apollo@masaischool.com' }, account, own).decision).toBe('NO_MATCH');
    expect(outsideMailFlow({ ...base, email: null }, account, own).decision).toBe('NO_MATCH');
  });
  it('leaves MailFlow-matched actions alone', () => {
    const matched = { ...base, decision: 'SUPPRESS', workspaceId: 'w1', sourceLabel: 'Recruiter Bulk Send “X”' };
    expect(outsideMailFlow(matched, account, own)).toBe(matched);
  });
});
