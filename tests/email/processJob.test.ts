import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendEmailError } from '@/lib/email/provider';

/**
 * Unit-level cover for the send processor's decision-making: idempotency,
 * pause/cancel honouring, and failure classification. The database is mocked
 * so these run without Postgres; the live pipeline is exercised separately
 * by scripts/smoke-test-send.ts.
 */

const db = {
  emailJob: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  batch: { update: vi.fn(), findUniqueOrThrow: vi.fn() },
  record: { update: vi.fn() },
  campaign: { update: vi.fn() },
  conversation: { upsert: vi.fn() },
  conversationMessage: { create: vi.fn() },
  recipientHistory: { create: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));

const { processEmailJob } = await import('@/lib/email/processJob');

function jobFixture(overrides: Record<string, any> = {}) {
  return {
    id: 'job1',
    batchId: 'batch1',
    recordId: 'rec1',
    status: 'QUEUED',
    toEmail: 'rahul@example.com',
    ccEmails: [],
    bccEmails: [],
    fromName: 'Abhishesh',
    fromEmail: 'abhishesh@masaischool.com',
    subject: 'Hi',
    html: '<p>Hi</p>',
    plainText: 'Hi',
    gmailThreadId: null,
    emailProviderAccountId: 'acct1',
    emailProviderAccount: { id: 'acct1', status: 'CONNECTED', emailAddress: 'abhishesh@masaischool.com' },
    record: { id: 'rec1', contactId: null },
    batch: {
      id: 'batch1',
      label: 'BATCH-001',
      status: 'RUNNING',
      campaign: { id: 'c1', status: 'RUNNING', organizationId: 'o1', workspaceId: 'w1', createdById: 'u1', name: 'C' },
    },
    ...overrides,
  };
}

function fakeProvider(impl: (input: any) => any) {
  return () => ({ name: 'fake', sendEmail: vi.fn(impl) });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.emailJob.update.mockResolvedValue({ id: 'job1', batchId: 'batch1', recordId: 'rec1' });
  db.batch.update.mockResolvedValue({});
  db.record.update.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)));
});

describe('processEmailJob — idempotency and guards', () => {
  it('never re-sends a job already marked SENT (§41)', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ status: 'SENT' }));
    const send = vi.fn();
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(send) });
    expect(result.status).toBe('SKIPPED');
    expect(result).toMatchObject({ reason: expect.stringContaining('Already sent') });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a cancelled job', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ status: 'CANCELLED' }));
    const send = vi.fn();
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(send) });
    expect(result.status).toBe('SKIPPED');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send while the batch is PAUSED (§43)', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ batch: { ...jobFixture().batch, status: 'PAUSED' } }));
    const send = vi.fn();
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(send) });
    expect(result.status).toBe('SKIPPED');
    expect(result).toMatchObject({ reason: 'Batch is paused.' });
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels the job when the campaign was cancelled', async () => {
    db.emailJob.findUnique.mockResolvedValue(
      jobFixture({ batch: { ...jobFixture().batch, campaign: { ...jobFixture().batch.campaign, status: 'CANCELLED' } } })
    );
    const send = vi.fn();
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(send) });
    expect(result.status).toBe('SKIPPED');
    expect(send).not.toHaveBeenCalled();
    expect(db.emailJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) })
    );
  });

  it('fails without retry when there is no sending account', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ emailProviderAccount: null }));
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(vi.fn()) });
    expect(result).toMatchObject({ status: 'FAILED', retryable: false });
  });

  it('fails retryably when the sending account is disconnected', async () => {
    db.emailJob.findUnique.mockResolvedValue(
      jobFixture({ emailProviderAccount: { id: 'a', status: 'EXPIRED', emailAddress: 'x@masaischool.com' } })
    );
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(vi.fn()) });
    expect(result).toMatchObject({ status: 'FAILED', retryable: true });
  });

  it('returns SKIPPED when the job row no longer exists', async () => {
    db.emailJob.findUnique.mockResolvedValue(null);
    const result = await processEmailJob('gone', { providerFactory: fakeProvider(vi.fn()) });
    expect(result.status).toBe('SKIPPED');
  });
});

describe('processEmailJob — sending', () => {
  it('sends and records the provider message + thread id', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture());
    const result = await processEmailJob('job1', {
      providerFactory: fakeProvider(async () => ({
        providerMessageId: 'gmail-msg-1',
        threadId: 'gmail-thread-1',
        messageIdHeader: '<abc@masaischool.com>',
      })),
    });

    expect(result).toMatchObject({ status: 'SENT', providerMessageId: 'gmail-msg-1' });
    expect(db.emailJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SENT',
          gmailMessageId: 'gmail-msg-1',
          gmailThreadId: 'gmail-thread-1',
        }),
      })
    );
  });

  it('passes the stored threadId through so replies stay in the thread (§46)', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ gmailThreadId: 'existing-thread' }));
    let received: any = null;
    await processEmailJob('job1', {
      providerFactory: fakeProvider(async (input: any) => {
        received = input;
        return { providerMessageId: 'm', threadId: 'existing-thread', messageIdHeader: '<m@x>' };
      }),
    });
    expect(received.threadId).toBe('existing-thread');
  });

  it('updates the record system fields without touching business data (§14)', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture());
    await processEmailJob('job1', {
      providerFactory: fakeProvider(async () => ({ providerMessageId: 'm', threadId: 't', messageIdHeader: '<m@x>' })),
    });
    const recordUpdate = db.record.update.mock.calls.at(-1)?.[0];
    expect(recordUpdate.data).toMatchObject({ emailStatus: 'SENT', lastCommunicationDirection: 'OUTBOUND' });
    expect(recordUpdate.data).not.toHaveProperty('data');
  });
});

describe('processEmailJob — failure classification (§42)', () => {
  it('rethrows a retryable error so the queue can back off', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture());
    await expect(
      processEmailJob('job1', {
        providerFactory: fakeProvider(async () => {
          throw new SendEmailError('rate limited', 'RATE_LIMIT');
        }),
      })
    ).rejects.toThrow('rate limited');
  });

  it('swallows a permanent error and marks the job FAILED without retry', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture());
    const result = await processEmailJob('job1', {
      providerFactory: fakeProvider(async () => {
        throw new SendEmailError('bad address', 'INVALID_RECIPIENT');
      }),
    });
    expect(result).toMatchObject({ status: 'FAILED', retryable: false });
    expect(db.emailJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'INVALID_RECIPIENT' }),
      })
    );
  });

  it('treats an auth failure as permanent for the queue but flags reconnection', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture());
    const result = await processEmailJob('job1', {
      providerFactory: fakeProvider(async () => {
        throw new SendEmailError('invalid_grant', 'AUTH');
      }),
    });
    expect(result).toMatchObject({ status: 'FAILED', retryable: false });
  });
});

describe('SendEmailError.retryable', () => {
  it.each([
    ['RATE_LIMIT', true],
    ['TRANSIENT', true],
    ['QUOTA', true],
    ['AUTH', false],
    ['INVALID_RECIPIENT', false],
    ['UNKNOWN', false],
  ] as const)('%s → retryable=%s', (kind, expected) => {
    expect(new SendEmailError('x', kind).retryable).toBe(expected);
  });
});
