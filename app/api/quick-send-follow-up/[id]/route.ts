import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { chainCandidates } from '@/lib/quickSend/followUp';
import { followUpSubject, parseSegments, segmentCounts, segmentOf } from '@/lib/recruiterSend/followUp';

/**
 * The finished Quick Send being followed up: its content (shown beside the new email), the chain of
 * rounds, and everyone who was sent an email in the chain with the group they are in. The compose
 * screen keeps the ticked people itself and sends their addresses with the follow-up.
 */
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  const parent = await prisma.campaign.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
    select: {
      id: true, name: true, status: true, round: true, rootCampaignId: true, createdAt: true, updatedAt: true, fromName: true, replyTo: true, ccEmails: true, bccEmails: true,
      templateVersion: { select: { subject: true, html: true } },
    },
  });
  if (!parent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (parent.status !== 'COMPLETED' && parent.status !== 'PARTIALLY_FAILED') {
    return NextResponse.json({ error: 'Only a send that has finished can be followed up.' }, { status: 409 });
  }
  const rootId = parent.rootCampaignId ?? parent.id;
  const [candidates, chain, sentFrom, open] = await Promise.all([
    chainCandidates(rootId, session.workspaceId),
    prisma.campaign.findMany({ where: { OR: [{ id: rootId }, { rootCampaignId: rootId }] }, orderBy: [{ round: 'asc' }, { createdAt: 'asc' }], select: { id: true, name: true, round: true, status: true } }),
    prisma.emailJob.findMany({ where: { campaignId: parent.id, status: 'SENT' }, distinct: ['fromEmail'], select: { fromEmail: true } }),
    prisma.campaign.findFirst({ where: { parentCampaignId: parent.id, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED'] } }, select: { id: true, status: true } }),
  ]);
  return NextResponse.json({
    parent: {
      id: parent.id, name: parent.name, round: parent.round, subject: parent.templateVersion.subject, html: sanitizeEmailHtml(parent.templateVersion.html),
      sentFrom: sentFrom.map((j) => j.fromEmail), finishedAt: parent.updatedAt, fromName: parent.fromName, replyTo: parent.replyTo, cc: parent.ccEmails, bcc: parent.bccEmails,
    },
    suggestedSubject: followUpSubject(parent.templateVersion.subject),
    chain: chain.map((c) => ({ ...c, current: c.id === parent.id })),
    counts: segmentCounts(candidates),
    // A follow-up to this send that is still going out blocks another.
    openFollowUp: open,
    candidates: candidates.map((c) => ({ email: c.email, name: c.name, segment: segmentOf(c), replied: c.replied, opened: c.opened, undeliverable: c.bounced || c.suppressed, lastSentAt: c.lastSentAt })),
    defaultSegments: parseSegments('NOT_REPLIED'),
  });
});
