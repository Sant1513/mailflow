import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The serverless sender (lib/queue/drain.ts): a Pause that lands mid-pass is never undone, the
 * job it claims is handed to processEmailJob as already claimed, and a mailbox whose token
 * expired mid-pass is re-read so the rest of the pass goes to a backup instead of failing.
 */
const db = {
  batch: { findUniqueOrThrow: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  emailJob: { count: vi.fn(async () => 0), findMany: vi.fn(), findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) },
  campaign: { findUnique: vi.fn() },
  emailProviderAccount: { findUnique: vi.fn() },
  recruiterBlastGroup: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  // usageLast24h: one aggregate row (nothing sent in the last 24 hours).
  $queryRaw: vi.fn(async () => [{ messages: 0n, total: 0n, uniq: null }]),
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const processEmailJob = vi.fn();
vi.mock('@/lib/email/processJob', () => ({
  processEmailJob: (...args: unknown[]) => processEmailJob(...args),
  reconcileBatchStatus: vi.fn(async () => 'COMPLETED'),
}));
vi.mock('@/lib/campaigns/fallback', () => ({
  fallbackOptIns: vi.fn(async () => new Set(['acc-backup'])),
  holdReasonText: (h: string) => h,
}));

process.env.EMAIL_SEND_GAP_MS = '0';
const { drainBatch } = await import('@/lib/queue/drain');

const job = (id: string) => ({ id, emailProviderAccountId: 'acc-main', toEmail: `${id}@x.com`, ccEmails: [], bccEmails: [], sendReason: null });

beforeEach(() => {
  vi.clearAllMocks();
  db.batch.findUniqueOrThrow.mockResolvedValue({ id: 'b1', campaignId: 'c1', status: 'RUNNING' });
  db.batch.updateMany.mockResolvedValue({ count: 1 });
  db.emailJob.findMany.mockResolvedValue([]);
  db.emailJob.count.mockResolvedValue(0);
  db.campaign.findUnique.mockResolvedValue({ organizationId: 'o1', fromName: null, fallbackAccountIds: ['acc-backup'] });
  db.emailProviderAccount.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, emailAddress: `${where.id}@masaischool.com`, displayName: null, status: 'CONNECTED' }));
});

describe('drainBatch', () => {
  it('does not undo a Pause that landed after the batch was read', async () => {
    db.batch.updateMany.mockResolvedValueOnce({ count: 0 });
    db.batch.findUnique.mockResolvedValue({ status: 'PAUSED' });
    db.emailJob.count.mockResolvedValue(3);
    const r = await drainBatch('b1');
    expect(r).toMatchObject({ processed: 0, remaining: 3, batchStatus: 'PAUSED' });
    expect(db.batch.updateMany).toHaveBeenCalledWith({ where: { id: 'b1', status: { notIn: ['PAUSED', 'CANCELLED'] } }, data: { status: 'RUNNING' } });
    expect(processEmailJob).not.toHaveBeenCalled();
  });

  it('hands the claimed job to processEmailJob as already claimed', async () => {
    db.emailJob.findMany.mockResolvedValue([job('j1')]);
    processEmailJob.mockResolvedValue({ status: 'SENT', emailJobId: 'j1', providerMessageId: 'm' });
    await drainBatch('b1');
    expect(processEmailJob).toHaveBeenCalledWith('j1', expect.objectContaining({ claimed: true }));
  });

  it('after a failed send it re-reads the mailbox, so an expired one reroutes to the backup', async () => {
    db.emailJob.findMany.mockResolvedValue([job('j1'), job('j2')]);
    let expired = false;
    db.emailProviderAccount.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      emailAddress: `${where.id}@masaischool.com`,
      displayName: null,
      status: where.id === 'acc-main' && expired ? 'EXPIRED' : 'CONNECTED',
    }));
    processEmailJob.mockImplementation(async (id: string) => {
      if (id === 'j1') {
        expired = true; // the auth failure marked the mailbox EXPIRED
        return { status: 'FAILED', emailJobId: id, reason: 'invalid_grant', retryable: false };
      }
      return { status: 'SENT', emailJobId: id, providerMessageId: 'm' };
    });
    await drainBatch('b1');
    // j2 was claimed onto the backup mailbox rather than failing on the expired one.
    const j2Claim = (db.emailJob.updateMany.mock.calls as any[][]).find((c) => c[0].where.id === 'j2')?.[0] as any;
    expect(j2Claim?.data).toMatchObject({ status: 'SENDING', emailProviderAccountId: 'acc-backup' });
  });
});
