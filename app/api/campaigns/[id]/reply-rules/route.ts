import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadCampaignForSession } from '@/lib/campaigns/context';
import { exampleReplyRules, replyRulesSchema } from '@/lib/replyRules/config';

/** A campaign's "When someone replies" rules (lib/replyRules), plus what the editor needs. */
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const parsed = replyRulesSchema.safeParse(campaign.replyRules);
  const [templates, members, columns, applied] = await Promise.all([
    prisma.template.findMany({ where: { workspaceId: campaign.workspaceId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({ where: { organizationId: session.organizationId, status: 'ACTIVE' }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
    prisma.datasetColumn.findMany({ where: { datasetId: campaign.datasetId }, select: { key: true, label: true }, orderBy: { order: 'asc' } }),
    prisma.auditLog.count({ where: { action: 'REPLY_RULE_APPLIED', metadata: { path: ['campaignId'], equals: campaign.id } } }),
  ]);
  return NextResponse.json({
    rules: parsed.success ? parsed.data : { ...exampleReplyRules(), enabled: false },
    templates,
    members,
    columns,
    applied,
    aiEnabled: process.env.AI_ENABLED !== 'false' && !!process.env.GEMINI_API_KEY,
  });
});

export const PUT = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const parsed = replyRulesSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: `Reply rules: ${first?.path.join('.') || 'value'} — ${first?.message ?? 'invalid'}` }, { status: 400 });
  }
  const templateIds = parsed.data.rules.map((r) => r.actions.replyTemplateId).filter((t): t is string => !!t);
  if (templateIds.length) {
    const found = await prisma.template.count({ where: { id: { in: templateIds }, workspaceId: campaign.workspaceId } });
    if (found !== new Set(templateIds).size) return NextResponse.json({ error: 'A chosen template is not in this workspace.' }, { status: 400 });
  }
  await prisma.campaign.update({ where: { id: campaign.id }, data: { replyRules: parsed.data as unknown as Prisma.InputJsonValue } });
  await audit(session, 'CAMPAIGN_REPLY_RULES_UPDATE', { targetType: 'Campaign', targetId: campaign.id, metadata: { enabled: parsed.data.enabled, rules: parsed.data.rules.length } });
  return NextResponse.json({ ok: true });
});
