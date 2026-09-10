import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadCampaignForSession, senderAccountFor } from '@/lib/campaigns/context';
import { CampaignStatus } from '@prisma/client';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (campaign.workspaceId !== session.workspaceId) {
    await audit(session, 'ADMIN_VIEW', { targetType: 'Campaign', targetId: campaign.id });
  }

  const sender = await senderAccountFor(campaign);

  return NextResponse.json({
    campaign,
    sender: sender ? { emailAddress: sender.emailAddress, status: sender.status } : null,
    viewerRole: session.role,
    viewerIsCreator: campaign.createdById === session.userId,
  });
});

/** Accepts a comma/semicolon/newline separated list or an array. */
const emailListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(/[,;\n]/))
      .map((e) => e.trim())
      .filter(Boolean)
  )
  .refine((list) => list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)), {
    message: 'One or more addresses are not valid email addresses.',
  })
  .refine((list) => list.length <= 25, { message: 'At most 25 addresses.' });

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  // §22. Note there is deliberately no fromEmail: the From address is
  // pinned to the connected mailbox so a campaign cannot spoof a sender.
  fromName: z.string().max(200).nullable().optional(),
  replyTo: z
    .string()
    .email('Reply-To must be a valid email address.')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  ccEmails: emailListSchema.optional(),
  bccEmails: emailListSchema.optional(),
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // A campaign that has started sending is immutable — editing it would
  // desynchronize what was actually sent from what the record claims (§126).
  const locked: CampaignStatus[] = [
    CampaignStatus.RUNNING,
    CampaignStatus.COMPLETED,
    CampaignStatus.PARTIALLY_FAILED,
    CampaignStatus.CANCELLED,
  ];
  if (locked.includes(campaign.status)) {
    return NextResponse.json({ error: `A ${campaign.status} campaign cannot be edited.` }, { status: 409 });
  }

  const body = patchSchema.parse(await req.json());
  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.fromName !== undefined ? { fromName: body.fromName } : {}),
      ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
      ...(body.ccEmails !== undefined ? { ccEmails: body.ccEmails } : {}),
      ...(body.bccEmails !== undefined ? { bccEmails: body.bccEmails } : {}),
      ...(body.scheduledAt !== undefined
        ? {
            scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
            status: body.scheduledAt ? CampaignStatus.SCHEDULED : campaign.status,
          }
        : {}),
    },
  });

  await audit(session, 'CAMPAIGN_UPDATE', { targetType: 'Campaign', targetId: campaign.id, metadata: body });

  return NextResponse.json({ campaign: updated });
});

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sentCount = await prisma.emailJob.count({ where: { campaignId: campaign.id, status: 'SENT' } });
  if (sentCount > 0) {
    // Sent history must survive (§89/§130) — cancel rather than delete.
    const cancelled = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: CampaignStatus.CANCELLED },
    });
    await audit(session, 'CAMPAIGN_CANCEL', {
      targetType: 'Campaign',
      targetId: campaign.id,
      metadata: { reason: 'delete requested but emails were already sent', sentCount },
    });
    return NextResponse.json({
      campaign: cancelled,
      cancelledInsteadOfDeleted: true,
      message: `Cancelled instead of deleted — ${sentCount} email(s) were already sent and their history is preserved.`,
    });
  }

  await prisma.campaign.delete({ where: { id: campaign.id } });
  await audit(session, 'CAMPAIGN_DELETE', { targetType: 'Campaign', targetId: campaign.id });
  return NextResponse.json({ ok: true });
});
