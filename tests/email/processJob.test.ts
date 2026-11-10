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
  batch: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  record: { update: vi.fn() },
  campaign: { update: vi.fn(), updateMany: vi.fn() },
  conversation: { upsert: vi.fn() },
  conversationMessage: { create: vi.fn() },
  recipientHistory: { create: vi.fn() },
  emailSuppression: { findFirst: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/email/gmail', () => ({ GmailProvider: class {} }));

const { processEmailJob, reconcileBatchStatus } = await import('@/lib/email/processJob');

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
  db.emailSuppression.findFirst.mockResolvedValue(null);
  db.emailJob.updateMany.mockResolvedValue({ count: 1 });
  db.batch.updateMany.mockResolvedValue({ count: 1 });
  db.campaign.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)));
});

describe('processEmailJob — claiming (no two consumers send the same job)', () => {
  it('claims QUEUED → SENDING before sending', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture());
    const send = vi.fn(async () => ({ providerMessageId: 'm', threadId: 't', messageIdHeader: '<m@x>' }));
    await processEmailJob('job1', { providerFactory: fakeProvider(send) });
    expect(db.emailJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'job1', status: { in: ['QUEUED', 'FAILED'] } }),
        data: expect.objectContaining({ status: 'SENDING' }),
      })
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('steps aside without sending when another consumer already claimed the job', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ status: 'SENDING' }));
    db.emailJob.updateMany.mockResolvedValueOnce({ count: 0 });
    const send = vi.fn();
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(send) });
    expect(result).toMatchObject({ status: 'SKIPPED', reason: expect.stringContaining('Another sender') });
    expect(send).not.toHaveBeenCalled();
  });

  it('a caller that already claimed it (the drain) sends without claiming again', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ status: 'SENDING' }));
    const send = vi.fn(async () => ({ providerMessageId: 'm', threadId: 't', messageIdHeader: '<m@x>' }));
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(send), claimed: true });
    expect(result.status).toBe('SENT');
    expect(db.emailJob.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SENDING' }) }));
  });

  it('claimed: true but the job is no longer SENDING → nothing is sent', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ status: 'QUEUED' }));
    const send = vi.fn();
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(send), claimed: true });
    expect(result.status).toBe('SKIPPED');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('processEmailJob — after Gmail accepted the email', () => {
  it('a failing bookkeeping write never marks the job FAILED (Retry failed would resend it)', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture());
    db.$transaction.mockRejectedValue(new Error('P2028 transaction timeout'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await processEmailJob('job1', {
      providerFactory: fakeProvider(async () => ({ providerMessageId: 'gm-1', threadId: 'th-1', messageIdHeader: '<m@x>' })),
    });
    errSpy.mockRestore();
    expect(result).toMatchObject({ status: 'SENT', providerMessageId: 'gm-1' });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    // Nothing wrote FAILED…
    for (const call of db.emailJob.update.mock.calls) expect(call[0].data.status).not.toBe('FAILED');
    expect(db.batch.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { failedCount: { increment: 1 } } }));
    // …and the job keeps Gmail's id while SENDING, so recovery marks it SENT.
    expect(db.emailJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job1', status: 'SENDING' },
        data: expect.objectContaining({ gmailMessageId: 'gm-1', gmailThreadId: 'th-1' }),
      })
    );
  }, 10_000);

  it('saves the unsubscribe token before sending, so the delivered link always works', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ unsubscribeToken: null }));
    const order: string[] = [];
    db.emailJob.update.mockImplementation(async (args: any) => {
      if (args.data.unsubscribeToken && !args.data.status) order.push('token');
      return { id: 'job1', batchId: 'batch1', recordId: 'rec1' };
    });
    await processEmailJob('job1', {
      providerFactory: fakeProvider(async () => {
        order.push('send');
        return { providerMessageId: 'm', threadId: 't', messageIdHeader: '<m@x>' };
      }),
    });
    expect(order).toEqual(['token', 'send']);
  });

  it('a retry after a transient bookkeeping error records the send once', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture());
    db.$transaction
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementation(async (fn: any) => fn(db));
    const result = await processEmailJob('job1', {
      providerFactory: fakeProvider(async () => ({ providerMessageId: 'gm-2', threadId: 't', messageIdHeader: '<m@x>' })),
    });
    expect(result.status).toBe('SENT');
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe('processEmailJob — suppression check', () => {
  it('matches an unsubscribe saved with different capitals', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ toEmail: 'Rahul@Example.com' }));
    db.emailSuppression.findFirst.mockResolvedValue({ reason: 'UNSUBSCRIBED' });
    const send = vi.fn();
    const result = await processEmailJob('job1', { providerFactory: fakeProvider(send) });
    expect(result.status).toBe('SKIPPED');
    expect(send).not.toHaveBeenCalled();
    expect(db.emailSuppression.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', email: { equals: 'Rahul@Example.com', mode: 'insensitive' } },
    });
  });
});

describe('reconcileBatchStatus — never undoes a Pause or Cancel', () => {
  it('leaves the batch PAUSED when a pause lands between the read and the write', async () => {
    db.batch.findUniqueOrThrow.mockResolvedValue({ id: 'b1', campaignId: 'c1', status: 'RUNNING', jobs: [{ status: 'QUEUED' }] });
    db.batch.updateMany.mockResolvedValueOnce({ count: 0 });
    db.batch.findUnique.mockResolvedValue({ status: 'PAUSED' });
    await expect(reconcileBatchStatus('b1')).resolves.toBe('PAUSED');
    expect(db.batch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1', status: { notIn: ['PAUSED', 'CANCELLED'] } } })
    );
    expect(db.campaign.updateMany).not.toHaveBeenCalled();
  });

  it('finishing a batch does not overwrite a paused campaign', async () => {
    db.batch.findUniqueOrThrow.mockResolvedValue({ id: 'b1', campaignId: 'c1', status: 'RUNNING', jobs: [{ status: 'SENT' }] });
    await expect(reconcileBatchStatus('b1')).resolves.toBe('COMPLETED');
    expect(db.campaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1', status: { notIn: ['PAUSED', 'CANCELLED'] } }, data: { status: 'COMPLETED' } })
    );
  });
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

  it('a new conversation from a send waits for the student instead of sitting in Open', async () => {
    db.emailJob.findUnique.mockResolvedValue(jobFixture({ record: { id: 'rec1', contactId: 'contact1' } }));
    db.conversation.upsert.mockResolvedValue({ id: 'conv1' });
    db.conversationMessage.create.mockResolvedValue({ id: 'msg1' });
    await processEmailJob('job1', {
      providerFactory: fakeProvider(async () => ({ providerMessageId: 'm', threadId: 't', messageIdHeader: '<m@x>' })),
    });
    const call = db.conversation.upsert.mock.calls.at(-1)?.[0];
    expect(call?.create.status).toBe('WAITING_FOR_STUDENT');
    // A later send on an existing thread leaves its status alone.
    expect(call?.update).not.toHaveProperty('status');
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
