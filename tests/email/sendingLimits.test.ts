import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Staying within Google's sending rules: one-click unsubscribe headers on
 * campaign mail, Gmail's daily-limit error read as "wait" (never as a
 * disconnected mailbox), and the daily cap / back-off settings.
 */

const sendMock = vi.fn();
const markExpired = vi.fn(async () => undefined);

vi.mock('googleapis', () => ({
  google: { gmail: () => ({ users: { messages: { send: sendMock, get: vi.fn() } } }) },
}));
vi.mock('@/lib/gmail/oauth', () => ({
  authorizedClientFor: vi.fn(async () => ({})),
  markAccountExpired: markExpired,
}));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

const { GmailProvider } = await import('@/lib/email/gmail');
const { buildMimeMessage } = await import('@/lib/email/mime');
const { dailyLimit, sendGapMs, BACKOFF_MS, addUsage, wouldExceedDaily, DAILY_UNIQUE_RECIPIENT_LIMIT } = await import('@/lib/queue/drain');

const account = { id: 'acct1', emailAddress: 'abhishesh@masaischool.com', displayName: 'A', status: 'CONNECTED' } as any;
const input = { to: 'student@example.com', fromName: 'A', fromEmail: 'abhishesh@masaischool.com', subject: 'Hi', html: '<p>Hi</p>' };
const headersOf = (raw: string) => raw.split('\r\n\r\n')[0] ?? '';

beforeEach(() => vi.clearAllMocks());

describe('one-click unsubscribe headers (Google sender guidelines, RFC 8058)', () => {
  it('campaign mail carries List-Unsubscribe and List-Unsubscribe-Post', () => {
    const { raw } = buildMimeMessage({ ...input, listUnsubscribeUrl: 'https://mailflow.example/api/unsubscribe/tok123' });
    const h = headersOf(raw);
    expect(h).toContain('List-Unsubscribe: <https://mailflow.example/api/unsubscribe/tok123>');
    expect(h).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('replies and other mail have no unsubscribe headers', () => {
    expect(headersOf(buildMimeMessage(input).raw)).not.toContain('List-Unsubscribe');
  });

  it('only accepts a clean https URL (no header injection, no http)', () => {
    for (const bad of ['http://x.example/u', 'https://x.example/u\r\nBcc: evil@x.com', 'https://x.example/<u>', 'javascript:alert(1)']) {
      expect(headersOf(buildMimeMessage({ ...input, listUnsubscribeUrl: bad }).raw)).not.toContain('List-Unsubscribe');
    }
  });

  it('the Gmail provider passes the URL through to the message', async () => {
    sendMock.mockResolvedValue({ data: { id: 'g1', threadId: 't1' } });
    await new GmailProvider(account).sendEmail({ ...input, listUnsubscribeUrl: 'https://mailflow.example/api/unsubscribe/abc' });
    const raw = Buffer.from(sendMock.mock.calls[0]![0].requestBody.raw, 'base64url').toString('utf8');
    expect(headersOf(raw)).toContain('List-Unsubscribe: <https://mailflow.example/api/unsubscribe/abc>');
  });
});

describe("Gmail's limit errors mean wait, not disconnect", () => {
  const fail = async (err: unknown) => {
    sendMock.mockRejectedValue(err);
    return new GmailProvider(account).sendEmail(input).catch((e) => e);
  };

  it('daily sending limit (403 dailyLimitExceeded) → QUOTA, mailbox not marked expired', async () => {
    const e = await fail({ code: 403, message: 'Daily user sending limit exceeded.', errors: [{ reason: 'dailyLimitExceeded' }] });
    expect(e.kind).toBe('QUOTA');
    expect(markExpired).not.toHaveBeenCalled();
  });

  it('"limit exceeded" wording without a reason → QUOTA', async () => {
    const e = await fail({ code: 403, message: 'User-rate limit exceeded. Retry after 2026-10-07T16:00:00Z' });
    expect(['QUOTA', 'RATE_LIMIT']).toContain(e.kind);
    expect(markExpired).not.toHaveBeenCalled();
  });

  it('per-user rate limit (429 / userRateLimitExceeded) → RATE_LIMIT', async () => {
    expect((await fail({ code: 429, message: 'Too many requests', errors: [{ reason: 'userRateLimitExceeded' }] })).kind).toBe('RATE_LIMIT');
  });

  it('a real permission problem is still AUTH', async () => {
    const e = await fail({ code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] });
    expect(e.kind).toBe('AUTH');
    expect(markExpired).toHaveBeenCalled();
  });
});

describe('pacing settings', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults: 3 s between emails, 1,500 emails a day (under Google’s 2,000)', () => {
    delete process.env.EMAIL_SEND_GAP_MS;
    delete process.env.EMAIL_DAILY_LIMIT;
    expect(sendGapMs()).toBe(3000);
    expect(dailyLimit()).toBe(1500);
  });

  it('the daily cap can be lowered (e.g. 500 for trial accounts) but never set above 1,900', () => {
    process.env.EMAIL_DAILY_LIMIT = '500';
    expect(dailyLimit()).toBe(500);
    process.env.EMAIL_DAILY_LIMIT = '5000';
    expect(dailyLimit()).toBe(1900);
  });

  it('back-off: 10 minutes after "slow down", an hour after a quota error', () => {
    expect(BACKOFF_MS.RATE_LIMIT).toBe(10 * 60_000);
    expect(BACKOFF_MS.QUOTA).toBe(60 * 60_000);
  });
});

describe('daily limits follow Google: messages, unique recipients, total recipients', () => {
  const fresh = () => ({ messages: 0, totalRecipients: 0, unique: new Set<string>() });
  const job = (n: number, cc: string[] = []) => ({ toEmail: `student${n}@example.com`, ccEmails: cc, bccEmails: [] as string[] });

  it('the same Cc on every email counts once as a unique recipient (750 emails + placements Cc is fine)', () => {
    delete process.env.EMAIL_DAILY_LIMIT;
    const u = fresh();
    for (let i = 0; i < 750; i++) addUsage(u, job(i, ['placements@masaischool.com']));
    expect(u.messages).toBe(750);
    expect(u.unique.size).toBe(751);
    expect(u.totalRecipients).toBe(1500);
    expect(wouldExceedDaily(u, job(750, ['placements@masaischool.com']))).toBe(false);
  });

  it('stops at 1,500 emails', () => {
    delete process.env.EMAIL_DAILY_LIMIT;
    const u = fresh();
    for (let i = 0; i < 1500; i++) addUsage(u, job(i));
    expect(wouldExceedDaily(u, job(1500))).toBe(true);
  });

  it('stops before 1,800 different recipients even with fewer emails', () => {
    process.env.EMAIL_DAILY_LIMIT = '1900';
    const u = fresh();
    for (let i = 0; i < 900; i++) addUsage(u, job(i, [`cc${i}@example.com`]));
    expect(u.unique.size).toBe(1800);
    expect(wouldExceedDaily(u, job(900))).toBe(true);
    // A repeat recipient adds nothing new.
    expect(wouldExceedDaily(u, job(5, ['cc5@example.com']))).toBe(u.messages + 1 > 1900);
    delete process.env.EMAIL_DAILY_LIMIT;
    expect(DAILY_UNIQUE_RECIPIENT_LIMIT).toBeLessThan(2000);
  });

  it('addresses are compared case-insensitively', () => {
    const u = fresh();
    addUsage(u, { toEmail: 'A@Example.com', ccEmails: ['P@masaischool.com'], bccEmails: [] });
    addUsage(u, { toEmail: 'a@example.com', ccEmails: ['p@MASAISCHOOL.com'], bccEmails: [] });
    expect(u.unique.size).toBe(2);
  });
});
