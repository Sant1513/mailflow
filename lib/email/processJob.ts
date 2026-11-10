import { prisma } from '@/lib/db/client';
import { GmailProvider } from '@/lib/email/gmail';
import { dispatchWebhook } from '@/lib/webhooks/dispatch';
import { recordHardBounce } from '@/lib/email/bounces';
import { SendEmailError, type EmailProvider } from '@/lib/email/provider';
import { buildReferences } from '@/lib/email/mime';
import { EmailJobStatus, BatchStatus, CampaignStatus, ConversationStatus, MessageDirection } from '@prisma/client';
import { generateJobDocuments, type GeneratedAttachment } from '@/lib/documents/campaign';
import { DocumentRenderError } from '@/lib/documents/render';
import { DocumentFileError } from '@/lib/documents/inspect';
import { buildRsvpUrl, injectTracking } from '@/lib/email/tracking';
import { placeRsvpBlock, readRsvpConfig, renderRsvpBlock, renderRsvpText, stripRsvpPlaceholder } from '@/lib/rsvp/config';
import { appBaseUrl } from '@/lib/app-url';
import { replyToHeader, unsubscribeButtonHtml } from '@/lib/recruiterSend/core';
import { unsubscribeMailto } from '@/lib/email/unsubscribeByEmail';
import crypto from 'crypto';

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
  options: {
    providerFactory?: (account: any) => EmailProvider;
    /** The caller already moved this job QUEUED → SENDING (lib/queue/drain.ts claims before calling). */
    claimed?: boolean;
  } = {}
): Promise<ProcessOutcome> {
  // With the personalised documents frozen onto this job at send time.
  const job = await loadJob(emailJobId);

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

  // Check the suppression list — if the recipient unsubscribed, skip silently.
  // Case-insensitive: older rows were saved with the address's original capitals.
  const suppressed = await prisma.emailSuppression.findFirst({
    where: {
      workspaceId: job.batch.campaign.workspaceId,
      email: { equals: job.toEmail.trim(), mode: 'insensitive' },
    },
  });
  if (suppressed) {
    await prisma.emailJob.update({
      where: { id: job.id },
      data: { status: EmailJobStatus.SKIPPED, skipReason: `Suppressed: ${suppressed.reason}` },
    });
    return { status: 'SKIPPED', emailJobId, reason: `${job.toEmail} is on the suppression list (${suppressed.reason}).` };
  }

  if (!job.emailProviderAccount) {
    await failJob(job.id, 'NO_SENDER', 'No connected sending account for this job.', false);
    return { status: 'FAILED', emailJobId, reason: 'No connected sending account.', retryable: false };
  }
  if (job.emailProviderAccount.status !== 'CONNECTED') {
    await failJob(job.id, 'SENDER_DISCONNECTED', `Sending account is ${job.emailProviderAccount.status}.`, true);
    return { status: 'FAILED', emailJobId, reason: 'Sending account needs reconnection.', retryable: true };
  }

  // Claim the job so two consumers (the BullMQ worker, the drain, a retry) can never both send it.
  // The drain claims before calling (claimed: true) and the job is then already SENDING; any other
  // caller moves it QUEUED (or FAILED, for a queue retry) → SENDING here, and steps aside if it lost.
  if (options.claimed) {
    if (job.status !== EmailJobStatus.SENDING) {
      return { status: 'SKIPPED', emailJobId, reason: 'Job is no longer claimed for sending.' };
    }
  } else {
    const claim = await prisma.emailJob.updateMany({
      where: { id: job.id, status: { in: [EmailJobStatus.QUEUED, EmailJobStatus.FAILED] } },
      data: { status: EmailJobStatus.SENDING, lastAttemptAt: new Date() },
    });
    if (!claim.count) {
      return { status: 'SKIPPED', emailJobId, reason: 'Another sender is already sending this email.' };
    }
  }

  const provider = options.providerFactory
    ? options.providerFactory(job.emailProviderAccount)
    : new GmailProvider(job.emailProviderAccount);

  // Personalised documents (agreements, forms): generated now from the values
  // frozen when the job was created, so the attachment is exactly what the
  // campaign approved. A bad value or broken PDF is permanent — retrying
  // cannot fix it; an infrastructure hiccup (e.g. loading the file) is not.
  let documents: GeneratedAttachment[] = [];
  const documentAttachments = job.attachments ?? [];
  if (documentAttachments.length > 0) {
    try {
      documents = await generateJobDocuments(documentAttachments);
    } catch (err) {
      const permanent = err instanceof DocumentRenderError || err instanceof DocumentFileError;
      const message = permanent
        ? (err as Error).message
        : `Could not generate the attached document: ${(err as Error).message ?? String(err)}`;
      await failJob(job.id, 'DOCUMENT_ERROR', message, !permanent);
      if (!permanent) throw new SendEmailError(message, 'TRANSIENT');
      return { status: 'FAILED', emailJobId, reason: message, retryable: false };
    }
  }

  // Generate an unsubscribe token for this job if it doesn't already have one. It is saved before
  // sending, so the link in the delivered email works even if the bookkeeping after the send fails.
  const unsubscribeToken: string = job.unsubscribeToken ?? crypto.randomUUID();
  if (!job.unsubscribeToken) {
    await prisma.emailJob.update({ where: { id: job.id }, data: { unsubscribeToken } });
  }

  let result: Awaited<ReturnType<EmailProvider['sendEmail']>>;
  try {
    const baseUrl = appBaseUrl();
    const unsubscribeUrl = `${baseUrl}/api/unsubscribe/${unsubscribeToken}`;

    // Build the footer — appended unconditionally so every campaign email has an unsubscribe link.
    const unsubscribeFooter = unsubscribeButtonHtml({ href: unsubscribeUrl, mailto: unsubscribeMailto(job.fromEmail, `cj-${unsubscribeToken}`) });

    // RSVP buttons (lib/rsvp/config.ts): this recipient's own signed links, at [[rsvp]] or before
    // the footer. They go to /rsvp/… directly, never through click tracking.
    const trackingPayload = { campaignId: job.campaignId, emailJobId: job.id, email: job.toEmail };
    const rsvpConfig = readRsvpConfig(job.batch.campaign.rsvp);
    const rsvpLink = (key: string) => buildRsvpUrl(trackingPayload, key);
    const bodyHtml = rsvpConfig ? placeRsvpBlock(job.html, renderRsvpBlock(rsvpConfig, rsvpLink)) : stripRsvpPlaceholder(job.html);
    const plainText = rsvpConfig
      ? `${stripRsvpPlaceholder(job.plainText ?? '')}${renderRsvpText(rsvpConfig, rsvpLink)}`
      : job.plainText
        ? stripRsvpPlaceholder(job.plainText)
        : job.plainText;

    // A full HTML document gets the footer inside <body>, not after </html>.
    const htmlWithFooter = /<\/body>/i.test(bodyHtml) ? bodyHtml.replace(/<\/body>/i, `${unsubscribeFooter}</body>`) : bodyHtml + unsubscribeFooter;

    const trackedHtml = injectTracking(
      htmlWithFooter,
      trackingPayload,
      job.batch.campaign.workspaceId
    );

    result = await provider.sendEmail({
      to: job.toEmail,
      cc: job.ccEmails,
      bcc: job.bccEmails,
      fromName: job.fromName,
      fromEmail: job.fromEmail,
      // A custom Reply-To keeps the sending mailbox too, so replies still reach the Inbox.
      replyTo: replyToHeader(job.replyTo, job.fromEmail),
      subject: job.subject,
      html: trackedHtml,
      plainText,
      threadId: job.gmailThreadId,
      listUnsubscribeUrl: unsubscribeUrl,
      listUnsubscribeMailto: unsubscribeMailto(job.fromEmail, `cj-${unsubscribeToken}`),
      ...(documents.length > 0
        ? { attachments: documents.map((d) => ({ filename: d.filename, mimeType: 'application/pdf', content: d.content })) }
        : {}),
    });
  } catch (err) {
    const sendError =
      err instanceof SendEmailError ? err : new SendEmailError(String((err as Error).message ?? err), 'UNKNOWN');

    await failJob(job.id, sendError.kind, sendError.message, sendError.retryable, sendError.providerResponse);

    // Let the queue see the error so BullMQ applies its backoff policy;
    // permanent failures are swallowed so they are not retried (§42).
    if (sendError.retryable) throw sendError;

    return { status: 'FAILED', emailJobId, reason: sendError.message, retryable: false };
  }

  // Gmail accepted the email. From here on nothing may mark the job FAILED: "Retry failed" would
  // send it a second time. The bookkeeping is retried; if it still can't be written, the job stays
  // SENDING with Gmail's message id, and recoverStuckJobs (lib/queue/sendWorker.ts) marks it SENT.
  const sent = result;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= BOOKKEEPING_ATTEMPTS; attempt++) {
    try {
      await recordSent(job, sent, unsubscribeToken, documents);
      return { status: 'SENT', emailJobId, providerMessageId: sent.providerMessageId };
    } catch (err) {
      lastError = err;
      if (attempt < BOOKKEEPING_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  console.error('[email] sent, but recording it failed; left SENDING for recovery', {
    emailJobId,
    providerMessageId: sent.providerMessageId,
    err: (lastError as Error)?.message ?? String(lastError),
  });
  await prisma.emailJob
    .updateMany({
      where: { id: job.id, status: EmailJobStatus.SENDING },
      data: { gmailMessageId: sent.providerMessageId, gmailThreadId: sent.threadId, messageIdHeader: sent.messageIdHeader },
    })
    .catch(() => undefined);
  return { status: 'SENT', emailJobId, providerMessageId: sent.providerMessageId };
}

const BOOKKEEPING_ATTEMPTS = 3;

type LoadedJob = NonNullable<Awaited<ReturnType<typeof loadJob>>>;
function loadJob(emailJobId: string) {
  return prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: {
      batch: { include: { campaign: true } },
      emailProviderAccount: true,
      record: true,
      attachments: {
        where: { campaignDocumentId: { not: null } },
        orderBy: { createdAt: 'asc' },
        include: { campaignDocument: { select: { fileId: true, fields: true, lockMode: true, stampReference: true } } },
      },
    },
  });
}

/** Everything written once Gmail has accepted the email, in one transaction. */
async function recordSent(
  job: LoadedJob,
  result: Awaited<ReturnType<EmailProvider['sendEmail']>>,
  unsubscribeToken: string,
  documents: GeneratedAttachment[]
): Promise<void> {
  let messageId: string | null = null;
  await prisma.$transaction(async (tx) => {
    await tx.emailJob.update({
      where: { id: job.id },
      data: {
        status: EmailJobStatus.SENT,
        sentAt: new Date(),
        unsubscribeToken,
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
          // Nothing to act on yet: the email was just sent. It waits for the student and moves to
          // Open (unread) the moment a real reply arrives (lib/gmail/ingest.ts). Starting it as
          // OPEN filled the inbox with one "open" conversation per recipient.
          status: ConversationStatus.WAITING_FOR_STUDENT,
        },
      });

      const message = await tx.conversationMessage.create({
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
          hasAttachments: documents.length > 0,
        },
      });
      messageId = message?.id ?? null;

      await tx.recipientHistory.create({
        data: {
          contactId: job.record.contactId,
          type: 'EMAIL_SENT',
          summary: `Sent "${job.subject}" (campaign ${job.batch.campaign.name})${
            documents.length > 0 ? ` with ${documents.map((d) => d.filename).join(', ')}` : ''
          }`,
          refId: job.id,
        },
      });
    }

    // Record what was actually attached. The hash lets "download sent copy"
    // prove a regenerated file is byte-identical to the one in the email.
    for (const d of documents) {
      await tx.attachment.update({
        where: { id: d.attachmentId },
        data: {
          sha256: d.sha256,
          size: d.size,
          generatedAt: new Date(),
          ...(messageId ? { conversationMessageId: messageId } : {}),
        },
      });
    }
  }, { maxWait: 10_000, timeout: 30_000 });
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

  // Auto-suppress an address Gmail rejected outright, so it is never retried. (QUOTA is our own
  // mailbox's daily limit, not the recipient's fault, so it never suppresses.)
  if (!retryable && code === 'INVALID_RECIPIENT') {
    const jobWithWorkspace = await prisma.emailJob.findUnique({
      where: { id: emailJobId },
      select: { toEmail: true, campaignId: true, campaign: { select: { workspaceId: true } } },
    });
    if (jobWithWorkspace?.toEmail && jobWithWorkspace.campaign?.workspaceId) {
      // Every workspace in the organization, with the reason (lib/email/bounces.ts).
      await recordHardBounce({
        workspaceId: jobWithWorkspace.campaign.workspaceId,
        email: jobWithWorkspace.toEmail,
        detail: `Gmail rejected the address when sending (${code}): ${message}`,
        campaignId: jobWithWorkspace.campaignId ?? null,
        webhook: false, // this path sends its own, with the job id
      }).catch((err) => {
        console.error('[email] auto-suppress failed', { emailJobId, err });
      });

      // Fire-and-forget webhook for permanent bounce.
      if (jobWithWorkspace?.toEmail && jobWithWorkspace.campaign?.workspaceId) {
        dispatchWebhook(jobWithWorkspace.campaign.workspaceId, 'email.bounced', {
          emailJobId,
          email: jobWithWorkspace.toEmail,
          errorCode: code,
          errorMessage: message,
        }).catch(() => undefined);
      }
    }
  }

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

  // Conditional: a Pause or Cancel that lands between the read above and this write wins.
  const written = await prisma.batch.updateMany({
    where: { id: batchId, status: { notIn: [BatchStatus.PAUSED, BatchStatus.CANCELLED] } },
    data: { status },
  });
  if (!written.count) {
    const now = await prisma.batch.findUnique({ where: { id: batchId }, select: { status: true } });
    return now?.status ?? status;
  }

  if (pending > 0) {
    // When the first job of a scheduled send fires, the campaign is still in
    // SCHEDULED status. Advance it to RUNNING so the UI reflects reality.
    await prisma.campaign.updateMany({
      where: { id: batch.campaignId, status: CampaignStatus.SCHEDULED },
      data: { status: CampaignStatus.RUNNING },
    });
  }

  if (pending === 0) {
    const campaignStatus =
      status === BatchStatus.COMPLETED
        ? CampaignStatus.COMPLETED
        : status === BatchStatus.PARTIALLY_FAILED
          ? CampaignStatus.PARTIALLY_FAILED
          : CampaignStatus.PARTIALLY_FAILED;
    await prisma.campaign.updateMany({
      where: { id: batch.campaignId, status: { notIn: [CampaignStatus.PAUSED, CampaignStatus.CANCELLED] } },
      data: { status: campaignStatus },
    });
  }

  return status;
}
