import { describe, expect, it, vi } from 'vitest';

const upserts: any[] = [];
const recipientUpdates: any[] = [];
vi.mock('@/lib/db/client', () => ({
  prisma: {
    recruiterBlast: { findUnique: vi.fn(async () => ({ id: 'b1', workspaceId: 'w-blast', name: 'Drive' })) },
    recruiterBlastRecipient: { updateMany: vi.fn(async (q: any) => { recipientUpdates.push(q); return { count: 1 }; }) },
    emailJob: { findFirst: vi.fn(async () => ({ toEmail: 'Student@Corp.com', campaignId: 'c1', campaign: { workspaceId: 'w-camp', name: 'Placement drive' } })) },
    emailSuppression: { upsert: vi.fn(async (q: any) => { upserts.push(q); return {}; }) },
  },
}));
vi.mock('@/lib/webhooks/dispatch', () => ({ dispatchWebhook: vi.fn(async () => undefined) }));

const { parseUnsubscribeSubject, handleUnsubscribeEmail, unsubscribeMailto } = await import('@/lib/email/unsubscribeByEmail');
const { buildMimeMessage } = await import('@/lib/email/mime');
const { listUnsubscribeToken, unsubscribeButtonHtml } = await import('@/lib/recruiterSend/core');

const headersOf = (raw: string) => raw.split('\r\n\r\n')[0] ?? '';
const base = { to: 'placements@masaischool.com', fromName: 'Masai', fromEmail: 'one@masaischool.com', subject: 'Hi', html: '<p>Hi</p>' };

describe('unsubscribe by email (works for BCC emails)', () => {
  it('reads the subject Gmail / our button sends, with or without a code', () => {
    expect(parseUnsubscribeSubject('Unsubscribe rb-abc123def456.sig0123456789')).toEqual({ kind: 'rb', token: 'abc123def456.sig0123456789' });
    expect(parseUnsubscribeSubject('Unsubscribe cj-11111111-2222-3333-4444-555555555555')).toEqual({ kind: 'cj', token: '11111111-2222-3333-4444-555555555555' });
    expect(parseUnsubscribeSubject('Re: unsubscribe me')).toEqual({ kind: 'plain' });
    expect(parseUnsubscribeSubject('UNSUBSCRIBE')).toEqual({ kind: 'plain' });
    // A normal reply that just mentions the word is not a request.
    expect(parseUnsubscribeSubject('Re: Hiring partners')).toBeNull();
    expect(parseUnsubscribeSubject('How do I unsubscribe from the other list?')).toBeNull();
  });

  it('BCC headers: mailto + web page, no one-click POST (the page cannot name the person)', () => {
    const mailto = unsubscribeMailto('one@masaischool.com', 'rb-tok');
    const h = headersOf(buildMimeMessage({ ...base, listUnsubscribeUrl: 'https://app.example/unsubscribe/list/tok', listUnsubscribeMailto: mailto, listUnsubscribeOneClick: false }).raw);
    expect(h).toContain('List-Unsubscribe: <mailto:one@masaischool.com?subject=Unsubscribe%20rb-tok');
    expect(h).toContain('<https://app.example/unsubscribe/list/tok>');
    expect(h).not.toContain('List-Unsubscribe-Post');
  });

  it('one person per email: one-click stays, with the mailto as a fallback', () => {
    const h = headersOf(buildMimeMessage({ ...base, listUnsubscribeUrl: 'https://app.example/api/unsubscribe/tok', listUnsubscribeMailto: unsubscribeMailto('one@masaischool.com', 'cj-tok') }).raw);
    expect(h).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(h).toMatch(/List-Unsubscribe: <mailto:[^>]+>, <https:\/\/app\.example\/api\/unsubscribe\/tok>/);
  });

  it('the button: BCC emails send the email; others open their own link', () => {
    const bcc = unsubscribeButtonHtml({ href: 'https://x/page', mailto: 'mailto:one@x.com?subject=Unsubscribe%20rb-1', primary: 'mailto' });
    expect(bcc).toContain('href="mailto:one@x.com?subject=Unsubscribe%20rb-1"');
    expect(bcc).toContain('unsubscribe on the web');
    const own = unsubscribeButtonHtml({ href: 'https://x/me', mailto: 'mailto:one@x.com', primary: 'href' });
    expect(own).toContain('href="https://x/me"');
    expect(own).not.toContain('unsubscribe on the web');
  });

  it('a BCC recruiter unsubscribes by email: suppressed in the send’s workspace and skipped later', async () => {
    upserts.length = 0;
    recipientUpdates.length = 0;
    const r = await handleUnsubscribeEmail({ workspaceId: 'w-mailbox', emailAddress: 'one@masaischool.com' }, 'HR@Recruiter.com', { kind: 'rb', token: listUnsubscribeToken('b1') });
    expect(r?.workspaceId).toBe('w-blast');
    expect(upserts.map((u) => u.create)).toEqual([expect.objectContaining({ workspaceId: 'w-blast', email: 'hr@recruiter.com', reason: 'UNSUBSCRIBED' })]);
    expect(upserts[0].update).toEqual({}); // a bounce stays a bounce
    expect(recipientUpdates[0].where).toMatchObject({ blastId: 'b1', email: 'hr@recruiter.com' });
  });

  it('a campaign email: the address it was sent to is suppressed too (replied from another address)', async () => {
    upserts.length = 0;
    await handleUnsubscribeEmail({ workspaceId: 'w-mailbox', emailAddress: 'one@masaischool.com' }, 'personal@gmail.com', { kind: 'cj', token: 'tok' });
    expect(upserts.map((u) => u.create.email).sort()).toEqual(['personal@gmail.com', 'student@corp.com']);
    expect(upserts[0].create).toMatchObject({ workspaceId: 'w-camp', campaignId: 'c1' });
  });

  it('a forged token falls back to the receiving mailbox’s workspace; our own address is ignored', async () => {
    upserts.length = 0;
    const r = await handleUnsubscribeEmail({ workspaceId: 'w-mailbox', emailAddress: 'one@masaischool.com' }, 'x@corp.com', { kind: 'rb', token: 'forged.token' });
    expect(r?.workspaceId).toBe('w-mailbox');
    expect(await handleUnsubscribeEmail({ workspaceId: 'w', emailAddress: 'one@masaischool.com' }, 'ONE@masaischool.com', { kind: 'plain' })).toBeNull();
  });
});
