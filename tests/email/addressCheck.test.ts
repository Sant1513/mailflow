import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    emailSuppression: {
      findMany: vi.fn(async () => [{ email: 'gone@college.edu', reason: 'BOUNCED', detail: '550 5.1.1 no such user' }, { email: 'bye@x.com', reason: 'UNSUBSCRIBED', detail: null }]),
    },
  },
}));
const { staticAddressProblem, checkAddresses } = await import('@/lib/email/addressCheck');
const { automatedReason } = await import('@/lib/email/botDetect');
const { dryRun, SKIP_REASONS } = await import('@/lib/campaigns/evaluate');

describe('pre-send address check', () => {
  it('spots typos of the big providers and suggests the fix', () => {
    expect(staticAddressProblem('rahul@gmial.com')).toMatchObject({ kind: 'LIKELY_TYPO' });
    expect(staticAddressProblem('rahul@gmail.con')?.detail).toContain('gmail.com');
    expect(staticAddressProblem('neha@yahooo.com')?.detail).toContain('yahoo.com');
    expect(staticAddressProblem('a@company.con')?.detail).toContain('company.com');
  });

  it('flags no-reply and throwaway addresses, leaves normal ones alone', () => {
    expect(staticAddressProblem('noreply@company.com')).toMatchObject({ kind: 'NO_REPLY_ADDRESS' });
    expect(staticAddressProblem('do-not-reply@x.org')).toMatchObject({ kind: 'NO_REPLY_ADDRESS' });
    expect(staticAddressProblem('test@mailinator.com')).toMatchObject({ kind: 'DISPOSABLE' });
    expect(staticAddressProblem('rahul@gmail.com')).toBeNull();
    expect(staticAddressProblem('placement@masaischool.com')).toBeNull();
  });

  it('marks suppressed addresses with the reason', async () => {
    const problems = await checkAddresses(['Gone@College.edu', 'bye@x.com', 'ok@gmail.com'], 'ws1', { dnsCheck: false });
    expect(problems.get('gone@college.edu')).toMatchObject({ kind: 'SUPPRESSED' });
    expect(problems.get('gone@college.edu')?.detail).toContain('bounced');
    expect(problems.get('bye@x.com')?.detail).toContain('unsubscribed');
    expect(problems.has('ok@gmail.com')).toBe(false);
  });

  it('skips problem addresses in the dry run, with the reason shown', () => {
    const records = [
      { id: 'r1', data: { Email: 'ok@gmail.com' } },
      { id: 'r2', data: { Email: 'rahul@gmial.com' } },
      { id: 'r3', data: { Email: 'gone@college.edu' } },
    ];
    const addressProblems = new Map([
      ['rahul@gmial.com', { kind: 'LIKELY_TYPO', detail: 'typo' }],
      ['gone@college.edu', { kind: 'SUPPRESSED', detail: 'bounced before' }],
    ]);
    const sim = dryRun(records, { emailColumnKey: 'Email', template: { subject: 'Hi', html: '<p>Hi</p>' }, addressProblems });
    expect(sim.wouldSend).toBe(1);
    expect(sim.byReason[SKIP_REASONS.BAD_ADDRESS]).toBe(1);
    expect(sim.byReason[SKIP_REASONS.SUPPRESSED]).toBe(1);
  });
});

describe('automated opens and clicks', () => {
  const sentAt = new Date('2026-11-02T10:00:00Z');
  const later = new Date('2026-11-02T10:30:00Z');
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

  it('counts a normal browser click and a Gmail image-proxy open as people', () => {
    expect(automatedReason({ type: 'CLICK', userAgent: chrome, sentAt, at: later })).toBeNull();
    expect(automatedReason({ type: 'OPEN', userAgent: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)', sentAt, at: later })).toBeNull();
  });

  it('flags link scanners, previews, scripts and missing user agents', () => {
    expect(automatedReason({ type: 'CLICK', userAgent: 'Mozilla/5.0 (compatible; Barracuda Sentinel)', sentAt, at: later })).toMatch(/security/);
    expect(automatedReason({ type: 'CLICK', userAgent: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)', sentAt, at: later })).toMatch(/Microsoft/);
    expect(automatedReason({ type: 'CLICK', userAgent: 'WhatsApp/2.23.20.0', sentAt, at: later })).toMatch(/preview/);
    expect(automatedReason({ type: 'CLICK', userAgent: 'python-requests/2.31', sentAt, at: later })).toMatch(/script/);
    expect(automatedReason({ type: 'OPEN', userAgent: null, sentAt, at: later })).toMatch(/no browser/);
  });

  it('flags a click within seconds of delivery', () => {
    expect(automatedReason({ type: 'CLICK', userAgent: chrome, sentAt, at: new Date(sentAt.getTime() + 4000) })).toMatch(/seconds/);
  });
});
