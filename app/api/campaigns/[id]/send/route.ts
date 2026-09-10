import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite, canWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import {
  loadCampaignForSession,
  buildEvaluationContext,
  senderAccountFor,
  emailColumnKeyOf,
  nextBatchLabel,
} from '@/lib/campaigns/context';
import { dryRun, validateCampaign } from '@/lib/campaigns/evaluate';
import { renderTemplate } from '@/lib/templates/variables';
import { enqueueEmailJobs } from '@/lib/queue/queues';
import { CampaignStatus, BatchStatus, EmailJobStatus } from '@prisma/client';

const sendSchema = z.object({
  /** §36: policy escape hatch for low-risk sends by authorized users. */
  skipApproval: z.boolean().default(false),
  /** §41 Force Resend — audited. */
  force: z.boolean().default(false),
});

/**
 * §33/§39/§40: validates, creates a Batch and one EmailJob per valid
 * recipient (each an immutable snapshot of exactly what will be sent), then
 * hands the jobs to the queue. This route NEVER sends inline — it only
 * enqueues, so a 263-recipient campaign does not block an HTTP request.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const body = sendSchema.parse(await req.json().catch(() => ({})));

  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // §36: an unapproved campaign cannot send unless policy allows a direct
  // send by an authorized user.
  const approved = campaign.status === CampaignStatus.APPROVED;
  const directSendAllowed = body.skipApproval && (session.role === 'ADMIN' || session.role === 'SUPER_ADMIN');
  if (!approved && !directSendAllowed) {
    return NextResponse.json(
      {
        error:
          campaign.status === CampaignStatus.PENDING_APPROVAL
            ? 'This campaign is awaiting approval.'
            : 'This campaign must be approved before sending. Submit it for approval first.',
        status: campaign.status,
      },
      { status: 409 }
    );
  }
  if ([CampaignStatus.RUNNING, CampaignStatus.COMPLETED, CampaignStatus.CANCELLED].includes(campaign.status as any)) {
    return NextResponse.json({ error: `Campaign is ${campaign.status}.` }, { status: 409 });
  }

  const sender = await senderAccountFor(campaign);
  if (!sender || sender.status !== 'CONNECTED') {
    return NextResponse.json(
      { error: 'No connected Gmail account for the campaign owner. Connect one in Settings first.' },
      { status: 400 }
    );
  }

  const label = await nextBatchLabel(campaign.id);
  const built = await buildEvaluationContext(campaign, { batchLabel: label, senderEmail: sender.emailAddress });
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 });

  // §41: Force Resend deliberately ignores the already-sent set.
  if (body.force) {
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
    canSend: canWrite(session.role),
  });

  // §33: any critical failure blocks the send outright.
  if (validation.blocked) {
    return NextResponse.json(
      { error: 'Validation failed — nothing was sent.', validation, simulation: { wouldSend: simulation.wouldSend } },
      { status: 400 }
    );
  }

  const sendable = simulation.evaluations.filter((e) => e.willSend);
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

    for (const evaluation of sendable) {
      const record = recordsById.get(evaluation.recordId)!;
      // Render ONCE, here, and store the result. The worker sends exactly
      // these bytes — it never re-renders from the template (§89/§126).
      const rendered = renderTemplate(
        {
          subject: campaign.templateVersion.subject,
          html: campaign.templateVersion.html,
          plainText: campaign.templateVersion.plainText,
        },
        record.data
      );

      const html = campaign.templateVersion.css
        ? `<style>${campaign.templateVersion.css}</style>${rendered.html}`
        : rendered.html;

      await tx.emailJob.create({
        data: {
          batchId: created.id,
          campaignId: campaign.id,
          recordId: record.id,
          templateVersionId: campaign.templateVersionId,
          emailProviderAccountId: sender.id,
          status: EmailJobStatus.QUEUED,
          toEmail: evaluation.email!,
          // Campaign-level Cc/Bcc go on every message (§22).
          ccEmails: campaign.ccEmails,
          bccEmails: campaign.bccEmails,
          // §30 sender snapshot — immutable, even if the user later renames
          // themselves or disconnects the account.
          fromName: campaign.fromName?.trim() || sender.displayName || campaign.createdBy.name,
          fromEmail: sender.emailAddress,
          replyTo: campaign.replyTo,
          subject: rendered.subject,
          html,
          plainText: rendered.plainText,
          sendReason: evaluation.sendReason,
        },
      });

      await tx.record.update({
        where: { id: record.id },
        data: { emailStatus: 'QUEUED', lastBatchId: created.id },
      });
    }

    // Skipped records get their reason persisted too (§91), so "why was
    // this person skipped" is answerable later, not just at dry-run time.
    for (const evaluation of simulation.evaluations.filter((e) => !e.willSend)) {
      await tx.record.update({
        where: { id: evaluation.recordId },
        data: { lastEmailError: evaluation.reasonDetail },
      }).catch(() => undefined);
    }

    await tx.campaign.update({
      where: { id: campaign.id },
      data: { status: CampaignStatus.RUNNING, senderAccountId: sender.id },
    });

    return created;
  });

  // Hand off to the queue. If Redis is not configured, the jobs stay QUEUED
  // in the database and are processed by POST /api/batches/:id/drain
  // instead — they are never silently dropped.
  const queuedJobs = await prisma.emailJob.findMany({
    where: { batchId: batch.id, status: EmailJobStatus.QUEUED },
    select: { id: true },
  });
  const enqueued = await enqueueEmailJobs(
    queuedJobs.map((j) => ({ emailJobId: j.id, batchId: batch.id }))
  );

  await prisma.batch.update({
    where: { id: batch.id },
    data: { status: enqueued.queued ? BatchStatus.QUEUED : BatchStatus.PREPARING },
  });

  await audit(session, 'CAMPAIGN_SEND', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: {
      batchId: batch.id,
      batchLabel: label,
      queued: sendable.length,
      skipped: simulation.skipped,
      force: body.force,
      skipApproval: body.skipApproval,
      transport: enqueued.queued ? 'redis' : 'drain',
    },
  });

  return NextResponse.json(
    {
      batch: { id: batch.id, label, total: simulation.total, queued: sendable.length, skipped: simulation.skipped },
      transport: enqueued.queued ? 'queue' : 'drain',
      note: enqueued.queued
        ? 'Jobs handed to the email-send queue.'
        : 'REDIS_URL is not configured, so jobs are queued in the database. Process them with POST /api/batches/:id/drain (or run the worker with Redis).',
      simulation: { wouldSend: simulation.wouldSend, skipped: simulation.skipped, byReason: simulation.byReason },
    },
    { status: 201 }
  );
});
