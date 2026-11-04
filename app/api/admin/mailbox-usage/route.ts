import { NextResponse } from 'next/server';
import { EmailJobStatus, Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { backoffUntil, dailyLimit, DAILY_TOTAL_RECIPIENT_LIMIT, DAILY_UNIQUE_RECIPIENT_LIMIT, usageLast24h } from '@/lib/queue/drain';

/**
 * Admins: how much every mailbox in the organisation has sent in the last 24 hours (campaigns
 * and Recruiter Bulk Send together, as Google counts them), against the daily limits — so no
 * one's mailbox gets pushed over.
 */
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const session = await requireRole([Role.ADMIN, Role.SUPER_ADMIN]);
  const since = new Date(Date.now() - 24 * 3600_000);
  const accounts = await prisma.emailProviderAccount.findMany({
    where: { organizationId: session.organizationId },
    select: { id: true, emailAddress: true, status: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { emailAddress: 'asc' },
  });

  const [campaignCounts, recruiterGroups] = await Promise.all([
    prisma.emailJob.groupBy({ by: ['emailProviderAccountId'], where: { emailProviderAccountId: { in: accounts.map((a) => a.id) }, status: EmailJobStatus.SENT, sentAt: { gte: since } }, _count: { _all: true } }),
    prisma.recruiterBlastGroup.groupBy({ by: ['accountId'], where: { accountId: { in: accounts.map((a) => a.id) }, status: 'SENT', sentAt: { gte: since } }, _count: { _all: true }, _sum: { recipientCount: true } }),
  ]);

  const mailboxes = await Promise.all(
    accounts.map(async (a) => {
      const [usage, paused] = await Promise.all([usageLast24h(a.id), backoffUntil(a.id)]);
      const campaign = campaignCounts.find((c) => c.emailProviderAccountId === a.id)?._count._all ?? 0;
      const recruiter = recruiterGroups.find((g) => g.accountId === a.id);
      return {
        id: a.id,
        emailAddress: a.emailAddress,
        status: a.status,
        owner: a.user ? { id: a.user.id, name: a.user.name, email: a.user.email } : null,
        messages: usage.messages,
        campaignEmails: campaign,
        recruiterMessages: recruiter?._count._all ?? 0,
        recruiterRecipients: recruiter?._sum.recipientCount ?? 0,
        uniqueRecipients: usage.unique.size,
        totalRecipients: usage.totalRecipients,
        pausedUntil: paused > 0 ? new Date(paused).toISOString() : null,
      };
    }),
  );

  return NextResponse.json({
    limits: { messages: dailyLimit(), uniqueRecipients: DAILY_UNIQUE_RECIPIENT_LIMIT, totalRecipients: DAILY_TOTAL_RECIPIENT_LIMIT },
    mailboxes: mailboxes.sort((x, y) => y.uniqueRecipients - x.uniqueRecipients),
  });
});
