import { prisma } from '@/lib/db/client';
import type { AppSession } from '@/lib/auth/session';
import { canWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { buildEvaluationContext, senderAccountFor, emailColumnKeyOf, nextBatchLabel, type LoadedCampaign } from '@/lib/campaigns/context';
import { dryRun, validateCampaign } from '@/lib/campaigns/evaluate';
import { renderTemplate } from '@/lib/templates/variables';
import { enqueueEmailJobs } from '@/lib/queue/queues';
import { kickSendWorker } from '@/lib/queue/sendWorker';
import { documentValidationIssues, jobAttachmentRows } from '@/lib/documents/campaign';
import { CampaignStatus, BatchStatus, EmailJobStatus, type Prisma } from '@prisma/client';

export interface StartSendOptions {
  campaign: LoadedCampaign;
  /** Who started the send (audited). The emails still go from the campaign owner's mailbox. */
  actor: AppSession;
  /** §36: policy escape hatch for low-risk sends by authorized users. */
  skipApproval?: boolean;
  /** §41 Force Resend — audited. */
  force?: boolean;
  /** A future time schedules the send instead of starting now. */
  scheduledAt?: Date | null;
  /** Where the send was started from, for the audit log (campaign page, quick send, approval). */
  via?: string;
}

export type StartSendResult =
  | { ok: true; status: 201; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * §33/§39/§40: validates, creates a Batch and one EmailJob per valid
 * recipient (each an immutable snapshot of exactly what will be sent), then
 * hands the jobs to the queue. This NEVER sends inline — it only enqueues,
 * so a 263-recipient campaign does not block an HTTP request. Shared by the
 * campaign Send button, Quick Send, and send-on-approval.
 */
export async function startCampaignSend(opts: StartSendOptions): Promise<StartSendResult> {
  const { campaign, actor } = opts;
  const scheduledAt = opts.scheduledAt ?? null;
  const now = new Date();
  const isScheduled = scheduledAt !== null && scheduledAt > now;
  const delayMs = isScheduled ? scheduledAt.getTime() - now.getTime() : 0;

  // §36: an unapproved campaign cannot send unless policy allows a direct
  // send by an authorized user.
  const approved = campaign.status === CampaignStatus.APPROVED;
  const directSendAllowed = !!opts.skipApproval && (actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN');
  if (!approved && !directSendAllowed) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          campaign.status === CampaignStatus.PENDING_APPROVAL
            ? 'This campaign is awaiting approval.'
            : 'This campaign must be approved before sending. Submit it for approval first.',
        status: campaign.status,
      },
    };
  }
  if (([CampaignStatus.RUNNING, CampaignStatus.COMPLETED, CampaignStatus.CANCELLED] as CampaignStatus[]).includes(campaign.status)) {
    return { ok: false, status: 409, body: { error: `Campaign is ${campaign.status}.` } };
  }

  const sender = await senderAccountFor(campaign);
  if (!sender || sender.status !== 'CONNECTED') {
    return { ok: false, status: 400, body: { error: 'No connected Gmail account for the campaign owner. Connect one in Settings first.' } };
  }

  const label = await nextBatchLabel(campaign.id);
  const built = await buildEvaluationContext(campaign, { batchLabel: label, senderEmail: sender.emailAddress });
  if ('error' in built) return { ok: false, status: 400, body: { error: built.error } };

  // §41: Force Resend deliberately ignores the already-sent set.
  if (opts.force) {
    built.ctx.alreadySentRecordIds = new Set();
  }

  const simulation = dryRun(built.records, built.ctx);

  const validation = validateCampaign({
    hasDataset: true,
    hasTemplate: true,
    hasEmailColumn: !!emailColumnKeyOf(campaign.dataset),
    senderConnected: true,
    senderStatus: sender.status,
    template: {
      subject: campaign.templateVersion.subject,
      html: campaign.templateVersion.html,
      plainText: campaign.templateVersion.plainText,
    },
    availableColumnKeys: campaign.dataset.columns.map((c) => c.key),
    recipientCount: simulation.wouldSend,
    canSend: canWrite(actor.role),
    documentIssues: documentValidationIssues(built.documents, campaign.dataset.columns.map((c) => c.key)),
  });

  // §33: any critical failure blocks the send outright.
  if (validation.blocked) {
    return { ok: false, status: 400, body: { error: 'Validation failed — nothing was sent.', validation, simulation: { wouldSend: simulation.wouldSend } } };
  }

  const sendable = simulation.evaluations.filter((e) => e.willSend);
  const fromName = campaign.fromName?.trim() || sender.displayName || campaign.createdBy.name;
  const sendTime = new Date();
  const recordsById = new Map(built.records.map((r) => [r.id, r]));

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.batch.create({
      data: {
        campaignId: campaign.id,
        label,
        status: BatchStatus.PREPARING,
        total: simulation.total,
        validCount: sendable.length,
        skippedCount: simulation.skipped,
      },
    });

    // Every snapshot is written in bulk (a 1,000-recipient send in a few statements instead of
    // 2,000+ round trips). Each job is rendered ONCE here and the worker sends exactly these
    // bytes — it never re-renders from the template (§89/§126). Campaign-level Cc/Bcc go on
    // every message (§22), and the sender is snapshotted (§30).
    const evaluationByRecord = new Map(sendable.map((e) => [e.recordId, e]));
    const jobs: Prisma.EmailJobCreateManyInput[] = sendable.map((evaluation) => {
      const record = recordsById.get(evaluation.recordId)!;
      const rendered = renderTemplate(
        { subject: campaign.templateVersion.subject, html: campaign.templateVersion.html, plainText: campaign.templateVersion.plainText },
        record.data
      );
      return {
        batchId: created.id,
        campaignId: campaign.id,
        recordId: record.id,
        templateVersionId: campaign.templateVersionId,
        emailProviderAccountId: sender.id,
        status: EmailJobStatus.QUEUED,
        toEmail: evaluation.email!,
        ccEmails: campaign.ccEmails,
        bccEmails: campaign.bccEmails,
        fromName,
        fromEmail: sender.emailAddress,
        replyTo: campaign.replyTo,
        subject: rendered.subject,
        html: campaign.templateVersion.css ? `<style>${campaign.templateVersion.css}</style>${rendered.html}` : rendered.html,
        plainText: rendered.plainText,
        sendReason: evaluation.sendReason,
      };
    });

    const attachmentRows: Prisma.AttachmentCreateManyInput[] = [];
    for (let i = 0; i < jobs.length; i += 1000) {
      const createdJobs = await tx.emailJob.createManyAndReturn({ data: jobs.slice(i, i + 1000), select: { id: true, recordId: true } });
      // Personalised documents: freeze each copy's values, file name and reference now; the PDF
      // itself is generated when this email is sent.
      if (built.documents.length > 0) {
        for (const job of createdJobs) {
          const record = recordsById.get(job.recordId)!;
          attachmentRows.push(
            ...jobAttachmentRows({
              emailJobId: job.id,
              docs: built.documents,
              data: record.data,
              recipientEmail: evaluationByRecord.get(job.recordId)!.email!,
              system: {
                campaignName: campaign.name,
                timezone: campaign.timezone,
                senderName: fromName,
                senderEmail: sender.emailAddress,
                now: sendTime,
              },
            })
          );
        }
      }
    }
    await tx.record.updateMany({
      where: { id: { in: sendable.map((e) => e.recordId) } },
      data: { emailStatus: 'QUEUED', lastBatchId: created.id },
    });

    for (let i = 0; i < attachmentRows.length; i += 2000) {
      await tx.attachment.createMany({ data: attachmentRows.slice(i, i + 2000) });
    }

    // Skipped records get their reason persisted too (§91), so "why was
    // this person skipped" is answerable later, not just at dry-run time.
    // One update per distinct reason, not per person.
    const skippedByReason = new Map<string, string[]>();
    for (const evaluation of simulation.evaluations.filter((e) => !e.willSend)) {
      const reason = evaluation.reasonDetail ?? '';
      skippedByReason.set(reason, [...(skippedByReason.get(reason) ?? []), evaluation.recordId]);
    }
    for (const [reason, ids] of skippedByReason) {
      await tx.record.updateMany({ where: { id: { in: ids } }, data: { lastEmailError: reason || null } });
    }

    await tx.campaign.update({
      where: { id: campaign.id },
      data: {
        status: isScheduled ? CampaignStatus.SCHEDULED : CampaignStatus.RUNNING,
        senderAccountId: sender.id,
        ...(isScheduled ? { scheduledAt } : {}),
      },
    });

    return created;
  }, { timeout: 60_000, maxWait: 10_000 });

  // Hand off to the queue. If Redis is not configured, the jobs stay QUEUED
  // in the database and the background sender (lib/queue/sendWorker.ts)
  // sends them — they are never silently dropped.
  const queuedJobs = await prisma.emailJob.findMany({
    where: { batchId: batch.id, status: EmailJobStatus.QUEUED },
    select: { id: true },
  });
  const enqueued = await enqueueEmailJobs(
    queuedJobs.map((j) => ({ emailJobId: j.id, batchId: batch.id })),
    delayMs
  );

  await prisma.batch.update({
    where: { id: batch.id },
    data: { status: enqueued.queued ? BatchStatus.QUEUED : BatchStatus.PREPARING },
  });

  // Without Redis the jobs wait in the database: start the background sender now.
  if (!enqueued.queued && !isScheduled) kickSendWorker('campaign-send');

  await audit(actor, 'CAMPAIGN_SEND', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: {
      batchId: batch.id,
      batchLabel: label,
      queued: sendable.length,
      skipped: simulation.skipped,
      force: !!opts.force,
      skipApproval: !!opts.skipApproval,
      transport: enqueued.queued ? 'redis' : 'drain',
      documents: built.documents.length,
      ...(opts.via ? { via: opts.via } : {}),
      ...(isScheduled ? { scheduledAt: scheduledAt!.toISOString() } : {}),
    },
  });

  const scheduleNote = isScheduled
    ? `Scheduled for ${scheduledAt!.toISOString()}. ${enqueued.queued ? 'BullMQ will fire at that time.' : 'It starts within about 15 minutes of that time.'}`
    : null;

  return {
    ok: true,
    status: 201,
    body: {
      batch: { id: batch.id, label, total: simulation.total, queued: sendable.length, skipped: simulation.skipped },
      transport: enqueued.queued ? 'queue' : 'drain',
      scheduled: isScheduled,
      scheduledAt: isScheduled ? scheduledAt!.toISOString() : null,
      note: scheduleNote ?? (enqueued.queued
        ? 'Jobs handed to the email-send queue.'
        : 'Sending started. Emails go out 3 seconds apart and continue in the background until the batch is done.'),
      simulation: { wouldSend: simulation.wouldSend, skipped: simulation.skipped, byReason: simulation.byReason },
    },
  };
}
