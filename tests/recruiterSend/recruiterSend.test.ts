import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── worker mocks ──
const sent: any[] = [];
const db = {
  recruiterBlast: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), count: vi.fn(async () => 0) },
  recruiterBlastGroup: { findMany: vi.fn(async () => []), findFirst: vi.fn(), count: vi.fn(async () => 1), groupBy: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn() },
  recruiterBlastRecipient: { findMany: vi.fn(), updateMany: vi.fn() },
  emailProviderAccount: { findUnique: vi.fn(), update: vi.fn() },
  documentTemplate: { findMany: vi.fn(async () => []) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@/lib/queue/drain', () => ({
  backoffUntil: vi.fn(async () => 0),
  usageLast24h: vi.fn(async () => ({ messages: 0, totalRecipients: 0, unique: new Set() })),
  wouldExceedDaily: vi.fn(() => false),
}));
vi.mock('@/lib/email/gmail', () => ({
  GmailProvider: class {
    constructor(private account: { emailAddress: string }) {}
    async sendEmail(input: any) {
      sent.push({ from: this.account.emailAddress, ...input });
      return { providerMessageId: `m${sent.length}`, threadId: 't', messageIdHeader: '<x>' };
    }
  },
}));
vi.mock('@/lib/storage/files', () => ({ readRef: vi.fn(), BUCKET: 'b', storageEnabled: () => false }));

const core = await import('@/lib/recruiterSend/core');
const { videoLinkCard, readVideo } = await import('@/lib/recruiterSend/video');
const { runRecruiterWorker } = await import('@/lib/recruiterSend/worker');

describe('recruiter lists', () => {
  it('reads pasted lists in every common shape, de-duplicated, with names', () => {
    const { recipients, unreadable } = core.parseRecipientText('priya@company.com\nRahul Mehta <Rahul@Corp.in>\nhr@startup.io, talent@agency.com\nPRIYA@company.com\njust a note');
    expect(recipients.map((r) => r.email)).toEqual(['priya@company.com', 'rahul@corp.in', 'hr@startup.io', 'talent@agency.com']);
    expect(recipients[1]!.name).toBe('Rahul Mehta');
    expect(recipients[2]!.name).toBeNull();
    expect(unreadable).toEqual(['just a note']);
  });

  it('splits into BCC groups of at most 250, or one per recruiter', () => {
    const ids = Array.from({ length: 600 }, (_, i) => `r${i}`);
    expect(core.planGroups(ids, 'BCC', 250).map((g) => g.length)).toEqual([250, 250, 100]);
    expect(core.planGroups(ids, 'BCC', 999).map((g) => g.length)).toEqual([250, 250, 100]);
    expect(core.planGroups(ids.slice(0, 3), 'INDIVIDUAL', 250)).toHaveLength(3);
  });
});

describe('the email', () => {
  it('signs open and unsubscribe tokens', () => {
    const t = core.openToken('grp1');
    expect(core.readOpenToken(t)).toBe('grp1');
    expect(core.readOpenToken(`${t}x`)).toBeNull();
    expect(core.readOpenToken('grp2.' + t.split('.')[1])).toBeNull();
    expect(core.readListUnsubscribeToken(core.listUnsubscribeToken('b1'))).toBe('b1');
    expect(core.readListUnsubscribeToken(core.openToken('b1'))).toBeNull();
  });

  it('adds the open pixel and unsubscribe line but leaves links exactly as written', () => {
    const html = '<html><body><p>Hi, see <a href="https://masaischool.com/jobs">openings</a></p></body></html>';
    const bcc = core.decorate(html, { groupId: 'g1', mode: 'BCC', workspaceId: 'w1', blastId: 'b1' });
    expect(bcc.html).toContain('href="https://masaischool.com/jobs"');
    expect(bcc.html).not.toContain('/api/track/click');
    expect(bcc.html).toContain('/api/track/rb/');
    expect(bcc.unsubscribeUrl).toContain('/unsubscribe/list/');
    const one = core.decorate(html, { groupId: 'g1', mode: 'INDIVIDUAL', workspaceId: 'w1', blastId: 'b1', recipientEmail: 'a@b.com' });
    expect(one.unsubscribeUrl).not.toContain('/unsubscribe/list/');
  });

  it('puts a link video before the signature, with a YouTube thumbnail', () => {
    const card = videoLinkCard('https://youtu.be/abcdEFG123', 'Our campus');
    expect(card).toContain('img.youtube.com/vi/abcdEFG123');
    const out = core.buildBody({ body: 'Hello', format: 'text', signature: '<b>Team</b>', videoCard: card });
    expect(out.html.indexOf('Our campus')).toBeLessThan(out.html.indexOf('<b>Team</b>'));
    expect(readVideo({ mode: 'link', url: 'http://x.com', title: 't' })).toBeNull(); // https only
  });
});

describe('sending', () => {
  const acc = (id: string, email: string) => ({ id, emailAddress: email, displayName: null, status: 'CONNECTED', refreshTokenEnc: 'x' });
  const blast = (over: Record<string, unknown> = {}) => ({
    id: 'b1', workspaceId: 'w1', mode: 'BCC', toAddress: 'placements@masaischool.com', subject: 'Hiring partners', html: '<p>Hi <a href="https://x.com">x</a></p>',
    plainText: 'Hi', fromName: 'Masai', replyTo: 'hr@masaischool.com', accountIds: ['a1', 'a2'], accountLimits: {}, video: null, attachmentDocumentIds: [], gapSeconds: 0, note: null, ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    db.recruiterBlastGroup.findFirst.mockImplementation(async (q: any) => (q.where.status === 'PENDING' ? { id: 'g1', seq: 1, attempts: 0 } : null));
    db.recruiterBlastRecipient.findMany.mockResolvedValue([{ id: 'r1', email: 'a@corp.com' }, { id: 'r2', email: 'b@corp.com' }]);
    db.emailProviderAccount.findUnique.mockImplementation(async (q: any) => (q.where.id === 'a1' ? acc('a1', 'one@masaischool.com') : acc('a2', 'two@masaischool.com')));
    db.recruiterBlast.findMany.mockResolvedValueOnce([blast()]).mockResolvedValue([]);
  });

  it('BCC: one message to the visible To, recruiters in Bcc, with Reply-To, links untouched', async () => {
    const r = await runRecruiterWorker({ budgetMs: 20_000 });
    expect(r.sent).toBe(1);
    expect(sent[0]).toMatchObject({ from: 'one@masaischool.com', to: 'placements@masaischool.com', bcc: ['a@corp.com', 'b@corp.com'], replyTo: 'hr@masaischool.com', listUnsubscribeUrl: null });
    expect(sent[0].html).toContain('href="https://x.com"');
    // The Message-ID and thread are kept so recruiters' replies find their way to the admin.
    expect(db.recruiterBlastGroup.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SENT', messageIdHeader: '<x>', gmailThreadId: 't' }) }));
  });

  it('moves to the next mailbox when one reaches the limit set for this send', async () => {
    db.recruiterBlast.findMany.mockReset().mockResolvedValueOnce([blast({ accountLimits: { a1: 300 } })]).mockResolvedValue([]);
    db.recruiterBlastGroup.groupBy.mockResolvedValue([{ accountId: 'a1', _sum: { recipientCount: 299 } }] as never);
    await runRecruiterWorker({ budgetMs: 20_000 });
    expect(sent[0].from).toBe('two@masaischool.com');
  });

  it('waits (and says why) when every chosen mailbox is at its limit', async () => {
    db.recruiterBlast.findMany.mockReset().mockResolvedValueOnce([blast({ accountIds: ['a1'], accountLimits: { a1: 1 } })]).mockResolvedValue([]);
    const r = await runRecruiterWorker({ budgetMs: 20_000 });
    expect(sent).toHaveLength(0);
    expect(r.waiting).toMatch(/reached the limit you set/);
  });
});
