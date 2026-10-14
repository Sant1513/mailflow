import { EmailJobStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';

/** Marks campaigns created on the Quick Send screen (shown as the campaign's description). */
export const QUICK_SEND_DESCRIPTION = 'Quick Send';
/** Audit action recording that an operator's Quick Send should go out as soon as it is approved. */
export const QUICK_SEND_ON_APPROVAL = 'QUICK_SEND_SEND_ON_APPROVAL';

export interface QuickSendStats {
  campaignId: string;
  name: string;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  total: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  opened: number;
  clicked: number;
  replied: number;
  unsubscribed: number;
  bounced: number;
  lastSentAt: string | null;
  batchId: string | null;
  batchStatus: string | null;
}

/** Progress and tracking for one campaign, counted the same way as campaign Analytics (unique people). */
export async function campaignStats(campaignId: string): Promise<QuickSendStats | null> {
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true, status: true, createdAt: true, scheduledAt: true, workspaceId: true, batches: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true } } },
  });
  if (!c) return null;
  const [groups, opens, clicks, last, bounced, threads] = await Promise.all([
    prisma.emailJob.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } }),
    prisma.emailTrackingEvent.findMany({ where: { campaignId, type: 'OPEN' }, distinct: ['email'], select: { email: true } }),
    prisma.emailTrackingEvent.findMany({ where: { campaignId, type: 'CLICK' }, distinct: ['email'], select: { email: true } }),
    prisma.emailJob.findFirst({ where: { campaignId, status: EmailJobStatus.SENT }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
    prisma.emailSuppression.count({ where: { campaignId, source: 'BOUNCE' } }),
    prisma.emailJob.findMany({ where: { campaignId, gmailThreadId: { not: null } }, select: { gmailThreadId: true }, distinct: ['gmailThreadId'] }),
  ]);
  const n = (s: EmailJobStatus) => groups.find((g) => g.status === s)?._count._all ?? 0;
  const threadIds = threads.map((t) => t.gmailThreadId!).filter(Boolean);
  // A reply = a real human answer in the email's thread (not a bounce or auto-reply).
  const replied = threadIds.length
    ? await prisma.conversation.count({
        where: { gmailThreadId: { in: threadIds }, messages: { some: { direction: 'INBOUND', classification: 'HUMAN_REPLY' } } },
      })
    : 0;
  const recipients = await prisma.emailJob.findMany({ where: { campaignId, status: EmailJobStatus.SENT }, select: { toEmail: true } });
  const unsubscribed = recipients.length
    ? await prisma.emailSuppression.count({
        where: {
          workspaceId: c.workspaceId,
          reason: 'UNSUBSCRIBED',
          createdAt: { gte: c.createdAt },
          email: { in: [...new Set(recipients.flatMap((r) => [r.toEmail, r.toEmail.toLowerCase()]))] },
        },
      })
    : 0;
  return {
    campaignId: c.id,
    name: c.name,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    scheduledAt: c.scheduledAt?.toISOString() ?? null,
    total: groups.reduce((s, g) => s + g._count._all, 0),
    queued: n(EmailJobStatus.QUEUED) + n(EmailJobStatus.SENDING),
    sent: n(EmailJobStatus.SENT),
    failed: n(EmailJobStatus.FAILED),
    skipped: n(EmailJobStatus.SKIPPED) + n(EmailJobStatus.CANCELLED),
    opened: opens.length,
    clicked: clicks.length,
    replied,
    unsubscribed,
    bounced,
    lastSentAt: last?.sentAt?.toISOString() ?? null,
    batchId: c.batches[0]?.id ?? null,
    batchStatus: c.batches[0]?.status ?? null,
  };
}
