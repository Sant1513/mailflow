import { prisma } from '@/lib/db/client';
import { GmailProvider } from '@/lib/email/gmail';
import { SendEmailError, type EmailProvider } from '@/lib/email/provider';
import { buildReferences } from '@/lib/email/mime';
import { EmailJobStatus, BatchStatus, CampaignStatus, MessageDirection } from '@prisma/client';

/**
 * Processes exactly one EmailJob. This is THE send path — the BullMQ worker
 * and the serverless drain endpoint both call it, so there is only one
 * implementation of what "sending" means.
 *
 * Guarantees:
 *  - idempotent: a job already SENT is never sent twice (§41)
 *  - respects pause/cancel between jobs (§43)
 *  - records an immutable snapshot of what was sent (§89)
 *  - classifies failures so permanent ones are not retried forever (§42)
 */

export type ProcessOutcome =
  | { status: 'SENT'; emailJobId: string; providerMessageId: string }
  | { status: 'SKIPPED'; emailJobId: string; reason: string }
  | { status: 'FAILED'; emailJobId: string; reason: string; retryable: boolean };

export async function processEmailJob(
  emailJobId: string,
  options: { providerFactory?: (account: any) => EmailProvider } = {}
): Promise<ProcessOutcome> {
  const job = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: {
      batch: { include: { campaign: true } },
      emailProviderAccount: true,
      record: true,
    },
  });

  if (!job) {
    return { status: 'SKIPPED', emailJobId, reason: 'Email job no longer exists.' };
  }

  // Idempotency: never re-send something already sent (§41).
  if (job.status === EmailJobStatus.SENT) {
    return { status: 'SKIPPED', emailJobId, reason: `Already sent in batch ${job.batch.label}.` };
  }
  if (job.status === EmailJobStatus.CANCELLED) {
    return { status: 'SKIPPED', emailJobId, reason: 'Job was cancelled.' };
  }

  // §43: pause/cancel are checked immediately before each send, so an
  // operator hitting Pause stops the very next message rather than waiting
  // for the whole batch to drain.
  if (job.batch.status === BatchStatus.PAUSED) {
    return { status: 'SKIPPED', emailJobId, reason: 'Batch is paused.' };
  }
  if (job.batch.status === BatchStatus.CANCELLED || job.batch.campaign.status === CampaignStatus.CANCELLED) {
    await prisma.emailJob.update({
      where: { id: job.id },
      data: { status: EmailJobStatus.CANCELLED, skipReason: 'Campaign or batch cancelled before sending.' },
    });
    return { status: 'SKIPPED', emailJobId, reason: 'Campaign cancelled.' };
  }

  if (!job.emailProviderAccount) {
    await failJob(job.id, 'NO_SENDER', 'No connected sending account for this job.', false);
    return { status: 'FAILED', emailJobId, reason: 'No connected sending account.', retryable: false };
  }
  if (job.emailProviderAccount.status !== 'CONNECTED') {
    await failJob(job.id, 'SENDER_DISCONNECTED', `Sending account is ${job.emailProviderAccount.status}.`, true);
    return { status: 'FAILED', emailJobId, reason: 'Sending account needs reconnection.', retryable: true };
  }

  await prisma.emailJob.update({
    where: { id: job.id },
    data: { status: EmailJobStatus.SENDING, lastAttemptAt: new Date() },
  });

  const provider = options.providerFactory
    ? options.providerFactory(job.emailProviderAccount)
    : new GmailProvider(job.emailProviderAccount);

  try {
    const result = await provider.sendEmail({
      to: job.toEmail,
      cc: job.ccEmails,
      bcc: job.bccEmails,
      fromName: job.fromName,
      fromEmail: job.fromEmail,
      replyTo: job.replyTo ?? undefined,
      subject: job.subject,
      html: job.html,
      plainText: job.plainText,
      threadId: job.gmailThreadId,
    });

    await prisma.$transaction(async (tx) => {
      await tx.emailJob.update({
        where: { id: job.id },
        data: {
          status: EmailJobStatus.SENT,
          sentAt: new Date(),
          gmailMessageId: result.providerMessageId,
          gmailThreadId: result.threadId,
          messageIdHeader: result.messageIdHeader,
          providerResponse: result.raw as any,
          errorCode: null,
          errorMessage: null,
        },
      });

      await tx.batch.update({
        where: { id: job.batchId },
        data: { sentCount: { increment: 1 } },
      });

      // §14: update the record's SYSTEM email fields only — never the
      // user's own business Status column.
      await tx.record.update({
        where: { id: job.recordId },
        data: {
          emailStatus: 'SENT',
          lastEmailSentAt: new Date(),
          lastEmailError: null,
          lastBatchId: job.batchId,
          gmailThreadId: result.threadId,
          lastCommunicationAt: new Date(),
          lastCommunicationDirection: 'OUTBOUND',
        },
      });

      // Record the outbound message in the conversation timeline so Phase 5
      // (inbound replies) has something to thread onto, and so the contact
      // history is complete from the first message (§45/§61).
      if (result.threadId && job.record.contactId) {
        const conversation = await tx.conversation.upsert({
          where: {
            emailProviderAccountId_gmailThreadId: {
              emailProviderAccountId: job.emailProviderAccountId!,
              gmailThreadId: result.threadId,
            },
          },
          update: { lastMessageAt: new Date(), messageCount: { increment: 1 } },
          create: {
            organizationId: job.batch.campaign.organizationId,
            workspaceId: job.batch.campaign.workspaceId,
            ownerId: job.batch.campaign.createdById,
            contactId: job.record.contactId,
            recipientEmail: job.toEmail,
            subject: job.subject,
            emailProviderAccountId: job.emailProviderAccountId!,
            gmailThreadId: result.threadId,
            firstMessageAt: new Date(),
            lastMessageAt: new Date(),
            messageCount: 1,
          },
        });

        await tx.conversationMessage.create({
          data: {
            conversationId: conversation.id,
            gmailMessageId: result.providerMessageId,
            gmailThreadId: result.threadId,
            direction: MessageDirection.OUTBOUND,
            senderEmail: job.fromEmail,
            senderName: job.fromName,
            recipientEmail: job.toEmail,
            cc: job.ccEmails,
            bcc: job.bccEmails,
            subject: job.subject,
            messageIdHeader: result.messageIdHeader,
            references: buildReferences(null, result.messageIdHeader),
            // §89: an immutable snapshot of exactly what was sent. Never
            // re-rendered from the current template later.
            // The inbox list shows the latest message's snippet, so an
            // outbound message without one rendered the literal string
            // "undefined" whenever a campaign email was the last thing sent.
            snippet: (job.plainText ?? job.html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200),
            htmlBody: job.html,
            plainTextBody: job.plainText,
            sentAt: new Date(),
            status: 'SENT',
            isRead: true,
          },
        });

        await tx.recipientHistory.create({
          data: {
            contactId: job.record.contactId,
            type: 'EMAIL_SENT',
            summary: `Sent "${job.subject}" (campaign ${job.batch.campaign.name})`,
            refId: job.id,
          },
        });
      }
    });

    return { status: 'SENT', emailJobId, providerMessageId: result.providerMessageId };
  } catch (err) {
    const sendError =
      err instanceof SendEmailError ? err : new SendEmailError(String((err as Error).message ?? err), 'UNKNOWN');

    await failJob(job.id, sendError.kind, sendError.message, sendError.retryable, sendError.providerResponse);

    // Let the queue see the error so BullMQ applies its backoff policy;
    // permanent failures are swallowed so they are not retried (§42).
    if (sendError.retryable) throw sendError;

    return { status: 'FAILED', emailJobId, reason: sendError.message, retryable: false };
  }
}

async function failJob(
  emailJobId: string,
  code: string,
  message: string,
  retryable: boolean,
  providerResponse?: unknown
): Promise<void> {
  const job = await prisma.emailJob.update({
    where: { id: emailJobId },
    data: {
      status: EmailJobStatus.FAILED,
      errorCode: code,
      errorMessage: message,
      providerResponse: (providerResponse ?? undefined) as any,
      retryCount: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });

  await prisma.batch.update({
    where: { id: job.batchId },
    data: { failedCount: { increment: 1 } },
  });

  await prisma.record.update({
    where: { id: job.recordId },
    data: { emailStatus: 'FAILED', lastEmailError: `${code}: ${message}` },
  }).catch(() => {
    /* record may have been deleted mid-flight */
  });

  console.error('[email] job failed', { emailJobId, code, retryable, message });
}

/**
 * Recomputes a batch's terminal status once no queued work remains (§39).
 * Called after each drain pass and when the worker empties the queue.
 */
export async function reconcileBatchStatus(batchId: string): Promise<BatchStatus> {
  const batch = await prisma.batch.findUniqueOrThrow({
    where: { id: batchId },
    include: { jobs: { select: { status: true } } },
  });

  if (batch.status === BatchStatus.PAUSED || batch.status === BatchStatus.CANCELLED) return batch.status;

  const counts = batch.jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] ?? 0) + 1;
    return acc;
  }, {});

  const pending = (counts[EmailJobStatus.QUEUED] ?? 0) + (counts[EmailJobStatus.SENDING] ?? 0);
  const failed = counts[EmailJobStatus.FAILED] ?? 0;
  const sent = counts[EmailJobStatus.SENT] ?? 0;

  let status: BatchStatus;
  if (pending > 0) status = BatchStatus.RUNNING;
  else if (failed > 0 && sent > 0) status = BatchStatus.PARTIALLY_FAILED;
  else if (failed > 0) status = BatchStatus.FAILED;
  else status = BatchStatus.COMPLETED;

  await prisma.batch.update({ where: { id: batchId }, data: { status } });

  if (pending === 0) {
    const campaignStatus =
      status === BatchStatus.COMPLETED
        ? CampaignStatus.COMPLETED
        : status === BatchStatus.PARTIALLY_FAILED
          ? CampaignStatus.PARTIALLY_FAILED
          : CampaignStatus.PARTIALLY_FAILED;
    await prisma.campaign.update({ where: { id: batch.campaignId }, data: { status: campaignStatus } });
  }

  return status;
}
