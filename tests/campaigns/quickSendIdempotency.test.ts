import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Quick Send is idempotent per compose: the browser sends one request key, so a second click or a
 * retry after a network error / timeout gets the send already made instead of emailing the list
 * twice. Two identical requests racing past the check are settled by the unique key.
 */
const db = {
  user: { findUnique: vi.fn(async () => ({ emailSignature: null })) },
  documentTemplate: { findMany: vi.fn(async () => []) },
  campaign: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  dataset: { create: vi.fn(async () => ({ id: 'ds1' })), delete: vi.fn(async () => ({})) },
  record: { createMany: vi.fn(async () => ({ count: 2 })) },
  template: { create: vi.fn(async () => ({ id: 'tpl1', versions: [{ id: 'tv1' }] })), delete: vi.fn(async () => ({})) },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const session = { userId: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'ADMIN', email: 'me@masaischool.com', name: 'Me', viewingAs: null };
vi.mock('@/lib/auth/session', () => ({ requireSession: vi.fn(async () => session) }));
vi.mock('@/lib/permissions/workspace', () => ({ requireCanWrite: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));
vi.mock('@/lib/records/contactLink', () => ({ linkContactsForDataset: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/addressCheck', () => ({ checkAddresses: vi.fn(async () => new Map()) }));
const startCampaignSend = vi.fn(async (..._args: unknown[]) => ({ ok: true, status: 200, body: { batchId: 'b1' } }));
vi.mock('@/lib/campaigns/startSend', () => ({ startCampaignSend: (...args: unknown[]) => startCampaignSend(...args) }));
vi.mock('@/lib/campaigns/context', () => ({
  senderAccountFor: vi.fn(async () => ({ id: 'acc1', emailAddress: 'me@masaischool.com', status: 'CONNECTED', displayName: 'Me' })),
  loadCampaignForSession: vi.fn(async () => ({ id: 'c-new' })),
}));
vi.mock('@/lib/campaigns/fallback', () => ({
  availableFallbackMailboxes: vi.fn(async () => []),
  validateFallbackList: vi.fn(async () => ({ ok: true, ids: [] })),
}));
vi.mock('@/lib/campaigns/approvalEmails', () => ({ sendApprovalRequestEmail: vi.fn(async () => 'SENT') }));
vi.mock('@/lib/queue/drain', () => ({ dailyLimit: () => 1500, usageLast24h: vi.fn(async () => ({ messages: 0, totalRecipients: 0, unique: new Set() })) }));

const { POST } = await import('@/app/api/quick-send/route');

const body = (requestId?: string) => ({
  mode: 'send',
  recipients: { kind: 'table', headers: ['Name', 'Email'], rows: [{ Name: 'Rahul', Email: 'rahul@example.com' }, { Name: 'Neha', Email: 'neha@example.com' }] },
  subject: 'Drive on Friday',
  body: 'Hi {{Name}}, see you on Friday.',
  ...(requestId ? { requestId } : {}),
});
const post = (b: unknown) => POST(new Request('http://localhost/api/quick-send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }) as any, {} as any);

beforeEach(() => {
  vi.clearAllMocks();
  db.campaign.findFirst.mockResolvedValue(null);
  db.campaign.create.mockResolvedValue({ id: 'c-new' });
});

describe('Quick Send — one send per compose', () => {
  it('stores the request key on the campaign it creates', async () => {
    const res = await post(body('req-12345678'));
    expect(res.status).toBe(201);
    expect(db.campaign.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ clientRequestId: 'req-12345678' }) }));
    expect(startCampaignSend).toHaveBeenCalledTimes(1);
  });

  it('a repeated send with the same key returns the first campaign and emails nobody again', async () => {
    db.campaign.findFirst.mockResolvedValue({ id: 'c-first', status: 'RUNNING', scheduledAt: null });
    const res = await post(body('req-12345678'));
    const json = await res.json();
    expect(json).toMatchObject({ campaignId: 'c-first', duplicate: true, state: 'sending' });
    expect(db.campaign.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { clientRequestId: 'req-12345678', workspaceId: 'w1' } }));
    expect(db.dataset.create).not.toHaveBeenCalled();
    expect(db.campaign.create).not.toHaveBeenCalled();
    expect(startCampaignSend).not.toHaveBeenCalled();
  });

  it('two identical sends racing: the loser cleans up and answers with the winner', async () => {
    db.campaign.findFirst
      .mockResolvedValueOnce(null) // the check before creating
      .mockResolvedValueOnce({ id: 'c-winner', status: 'PENDING_APPROVAL', scheduledAt: null }); // after the conflict
    db.campaign.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }));
    const res = await post(body('req-12345678'));
    const json = await res.json();
    expect(json).toMatchObject({ campaignId: 'c-winner', duplicate: true, state: 'awaiting_approval' });
    expect(db.template.delete).toHaveBeenCalledWith({ where: { id: 'tpl1' } });
    expect(db.dataset.delete).toHaveBeenCalledWith({ where: { id: 'ds1' } });
    expect(startCampaignSend).not.toHaveBeenCalled();
  });

  it('works without a key (older open tabs)', async () => {
    const res = await post(body());
    expect(res.status).toBe(201);
    expect(db.campaign.findFirst).not.toHaveBeenCalled();
    expect(db.campaign.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ clientRequestId: null }) }));
  });
});
