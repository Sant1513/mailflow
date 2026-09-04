import { prisma } from '@/lib/db/client';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { ColumnType, Role, EmailJobStatus, EmailProvider as EmailProviderEnum } from '@prisma/client';
import type { EvaluableRecord, EvaluationContext } from './evaluate';

/**
 * Assembles everything the dry run and the real send need, from one place,
 * so "simulate" and "send" can never disagree about the inputs.
 */
export async function loadCampaignForSession(session: AppSession, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      dataset: { include: { columns: true } },
      template: true,
      templateVersion: true,
      automation: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } },
      batches: { orderBy: { createdAt: 'desc' } },
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });
  if (!campaign) return null;
  if (campaign.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return campaign;
}

export type LoadedCampaign = NonNullable<Awaited<ReturnType<typeof loadCampaignForSession>>>;

/** Finds the sending account for a campaign's creator (§28/§30). */
export async function senderAccountFor(campaign: { workspaceId: string; createdById: string }) {
  return prisma.emailProviderAccount.findUnique({
    where: {
      workspaceId_userId_provider: {
        workspaceId: campaign.workspaceId,
        userId: campaign.createdById,
        provider: EmailProviderEnum.GMAIL,
      },
    },
  });
}

export function emailColumnKeyOf(dataset: { columns: { key: string; type: ColumnType }[] }): string | null {
  return dataset.columns.find((c) => c.type === ColumnType.EMAIL)?.key ?? null;
}

/**
 * Builds the evaluation context for a campaign: records, already-sent set,
 * and the origin metadata used to write "why was this sent" (§35).
 */
export async function buildEvaluationContext(
  campaign: LoadedCampaign,
  options: { batchLabel?: string; senderEmail?: string | null } = {}
): Promise<{ records: EvaluableRecord[]; ctx: EvaluationContext } | { error: string }> {
  const emailColumnKey = emailColumnKeyOf(campaign.dataset);
  if (!emailColumnKey) return { error: 'The dataset has no email column.' };

  const records = await prisma.record.findMany({
    where: { datasetId: campaign.datasetId },
    orderBy: { createdAt: 'asc' },
  });

  // §41: idempotency is keyed on (campaign, record, templateVersion), so a
  // re-run of the same campaign with the same template version skips
  // anyone already sent, while a NEW version is legitimately sendable.
  const alreadySent = await prisma.emailJob.findMany({
    where: {
      campaignId: campaign.id,
      templateVersionId: campaign.templateVersionId,
      status: { in: [EmailJobStatus.SENT, EmailJobStatus.SENDING] },
    },
    select: { recordId: true },
  });

  return {
    records: records.map((r) => ({ id: r.id, data: (r.data ?? {}) as Record<string, unknown> })),
    ctx: {
      emailColumnKey,
      template: {
        subject: campaign.templateVersion.subject,
        html: campaign.templateVersion.html,
        plainText: campaign.templateVersion.plainText,
      },
      alreadySentRecordIds: new Set(alreadySent.map((j) => j.recordId)),
      origin: {
        campaignName: campaign.name,
        automationName: campaign.automation?.name,
        templateName: campaign.template.name,
        templateVersion: campaign.templateVersion.version,
        batchLabel: options.batchLabel,
        senderEmail: options.senderEmail ?? undefined,
      },
    },
  };
}

/** §39: BATCH-YYYY-MM-DD-NNN, unique within a campaign. */
export async function nextBatchLabel(campaignId: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const prefix = `BATCH-${today}-`;
  const todaysBatches = await prisma.batch.count({
    where: { campaignId, label: { startsWith: prefix } },
  });
  return `${prefix}${String(todaysBatches + 1).padStart(3, '0')}`;
}
