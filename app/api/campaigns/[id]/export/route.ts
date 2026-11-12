import { NextResponse } from 'next/server';
import { EmailJobStatus, MessageClassification, MessageDirection } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { FILTER_LABEL, csvFileName, csvResponse, parseOpenFilter, toCsv, type CsvValue } from '@/lib/export/csv';

/**
 * GET /api/campaigns/:id/export?filter=all|opened|not_opened → CSV of everyone the campaign
 * (or Quick Send, which is a campaign too) emailed: sent / opened / clicked / replied /
 * unsubscribed / bounced, the mailbox that sent it, why it was skipped or failed, and the row's
 * own columns from the dataset (so UTM ids and names come along).
 *
 * Opens and clicks are counted the same way as the campaign's Analytics: link scanners and
 * preview bots (automated events) are left out. "Not opened" = sent and no real open yet.
 */
export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = { SENT: 'Sent', FAILED: 'Failed', SKIPPED: 'Skipped', QUEUED: 'Queued', SENDING: 'Sending', CANCELLED: 'Cancelled' };
/** Inbound messages that are not a person writing back. */
const NOT_A_REPLY: MessageClassification[] = [MessageClassification.BOUNCE, MessageClassification.DELIVERY_FAILURE, MessageClassification.OUT_OF_OFFICE, MessageClassification.AUTO_REPLY];

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 403 });
  const campaign = await prisma.campaign.findFirst({ where: { id: params.id, workspaceId: session.workspaceId }, select: { id: true, name: true, datasetId: true } });
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const filter = parseOpenFilter(new URL(req.url).searchParams.get('filter'));

  const [jobs, opens, clicks, suppressions, columns] = await Promise.all([
    prisma.emailJob.findMany({
      where: { campaignId: campaign.id },
      select: { id: true, toEmail: true, status: true, sentAt: true, fromEmail: true, skipReason: true, errorMessage: true, gmailThreadId: true, record: { select: { data: true } } },
      orderBy: { toEmail: 'asc' },
    }),
    prisma.emailTrackingEvent.groupBy({ by: ['emailJobId'], where: { campaignId: campaign.id, type: 'OPEN', automated: false }, _min: { createdAt: true }, _count: { _all: true } }),
    prisma.emailTrackingEvent.groupBy({ by: ['emailJobId'], where: { campaignId: campaign.id, type: 'CLICK', automated: false }, _min: { createdAt: true }, _count: { _all: true } }),
    prisma.emailSuppression.findMany({ where: { campaignId: campaign.id }, select: { email: true, reason: true } }),
    prisma.datasetColumn.findMany({ where: { datasetId: campaign.datasetId, isSystem: false }, select: { key: true, label: true }, orderBy: { order: 'asc' } }),
  ]);

  const openBy = new Map(opens.map((o) => [o.emailJobId, { first: o._min.createdAt, count: o._count._all }]));
  const clickBy = new Map(clicks.map((c) => [c.emailJobId, { first: c._min.createdAt, count: c._count._all }]));
  const suppressed = new Map(suppressions.map((s) => [s.email.toLowerCase(), s.reason]));

  // Replies: a person's inbound message in the thread the email started.
  const threadIds = [...new Set(jobs.map((j) => j.gmailThreadId).filter((t): t is string => !!t))];
  const replyBy = new Map<string, Date>();
  for (let i = 0; i < threadIds.length; i += 1000) {
    const rows = await prisma.conversationMessage.groupBy({
      by: ['gmailThreadId'],
      where: { gmailThreadId: { in: threadIds.slice(i, i + 1000) }, direction: MessageDirection.INBOUND, classification: { notIn: NOT_A_REPLY } },
      _min: { createdAt: true },
    });
    for (const r of rows) if (r.gmailThreadId && r._min.createdAt) replyBy.set(r.gmailThreadId, r._min.createdAt);
  }

  const picked = jobs.filter((j) => {
    if (filter === 'opened') return openBy.has(j.id);
    if (filter === 'not_opened') return j.status === EmailJobStatus.SENT && !openBy.has(j.id);
    return true;
  });

  const headers = ['Email', 'Status', 'Opened', 'First opened (IST)', 'Opens', 'Clicked', 'Clicks', 'Replied', 'Replied at (IST)', 'Unsubscribed', 'Bounced', 'Sent at (IST)', 'Sent from', 'Skip / fail reason', ...columns.map((c) => c.label)];
  const rows: CsvValue[][] = picked.map((j) => {
    const sent = j.status === EmailJobStatus.SENT;
    const o = openBy.get(j.id);
    const c = clickBy.get(j.id);
    const replied = j.gmailThreadId ? replyBy.get(j.gmailThreadId) : undefined;
    const reason = suppressed.get(j.toEmail.toLowerCase());
    const data = (j.record?.data ?? {}) as Record<string, unknown>;
    return [
      j.toEmail,
      STATUS_LABEL[j.status] ?? j.status,
      o ? 'Yes' : sent ? 'No' : '',
      o?.first,
      o?.count ?? 0,
      c ? 'Yes' : sent ? 'No' : '',
      c?.count ?? 0,
      replied ? 'Yes' : sent ? 'No' : '',
      replied,
      reason === 'UNSUBSCRIBED' ? 'Yes' : '',
      reason === 'BOUNCED' ? 'Yes' : '',
      j.sentAt,
      j.fromEmail,
      j.skipReason ?? j.errorMessage ?? '',
      ...columns.map((col) => (data[col.key] === undefined || data[col.key] === null ? '' : String(data[col.key]))),
    ];
  });

  await audit(session, 'CAMPAIGN_EXPORT', { targetType: 'Campaign', targetId: campaign.id, metadata: { filter, rows: rows.length } }).catch(() => undefined);
  return csvResponse(toCsv(headers, rows), csvFileName(campaign.name, FILTER_LABEL[filter]));
});
