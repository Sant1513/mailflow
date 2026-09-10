import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { SlackClient, mention, slackConfigured } from '@/lib/slack/client';
import { appUrl } from '@/lib/campaigns/approvalEmails';

/**
 * Slack integration settings (SUPER_ADMIN). The bot token lives only in the
 * environment (SLACK_BOT_TOKEN); this stores the channel and the switches.
 */
const putSchema = z.object({
  slackChannelId: z.string().trim().max(40).regex(/^[CG][A-Z0-9]{6,}$|^$/, 'Channel ids look like C0123ABCD').nullable().optional(),
  slackNotifyAssignments: z.boolean().optional(),
  slackNotifyResolutions: z.boolean().optional(),
  slackNotifyFollowUps: z.boolean().optional(),
});

async function current(organizationId: string) {
  const row = await prisma.integrationSettings.findUnique({ where: { organizationId } });
  return {
    slackConfigured: slackConfigured(),
    slackChannelId: row?.slackChannelId ?? null,
    slackNotifyAssignments: row?.slackNotifyAssignments ?? true,
    slackNotifyResolutions: row?.slackNotifyResolutions ?? true,
    slackNotifyFollowUps: row?.slackNotifyFollowUps ?? true,
    updatedAt: row?.updatedAt ?? null,
  };
}

export const GET = withErrorHandling(async () => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const settings = await current(session.organizationId);
  let bot: { ok: boolean; user?: string; team?: string; error?: string } = { ok: false, error: 'not configured' };
  let channel: { ok: boolean; name?: string; isMember?: boolean; error?: string } = { ok: false };
  const slack = SlackClient.fromEnv();
  if (slack) {
    const a = await slack.authTest();
    bot = a.ok ? { ok: true, user: a.data?.user, team: a.data?.team } : { ok: false, error: a.error };
    if (settings.slackChannelId) {
      const c = await slack.channelInfo(settings.slackChannelId);
      channel = c.ok ? { ok: true, name: c.data?.channel.name, isMember: c.data?.channel.is_member } : { ok: false, error: c.error };
    }
  }
  return NextResponse.json({ settings, bot, channel });
});

export const PUT = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  if (session.viewingAs) return NextResponse.json({ error: 'Read-only while viewing another workspace' }, { status: 403 });
  const body = putSchema.parse(await req.json());
  const data = {
    ...(body.slackChannelId !== undefined ? { slackChannelId: body.slackChannelId || null } : {}),
    ...(body.slackNotifyAssignments !== undefined ? { slackNotifyAssignments: body.slackNotifyAssignments } : {}),
    ...(body.slackNotifyResolutions !== undefined ? { slackNotifyResolutions: body.slackNotifyResolutions } : {}),
    ...(body.slackNotifyFollowUps !== undefined ? { slackNotifyFollowUps: body.slackNotifyFollowUps } : {}),
    updatedById: session.userId,
  };
  await prisma.integrationSettings.upsert({
    where: { organizationId: session.organizationId },
    create: { organizationId: session.organizationId, ...data },
    update: data,
  });
  await audit(session, 'INTEGRATION_SETTINGS_UPDATE', { targetType: 'Organization', targetId: session.organizationId, metadata: { fields: Object.keys(body) } });
  return NextResponse.json({ settings: await current(session.organizationId) });
});

/** Sends a test message to the configured channel, mentioning the caller if they have a Slack id. */
export const POST = withErrorHandling(async () => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const settings = await current(session.organizationId);
  const slack = SlackClient.fromEnv();
  if (!slack) return NextResponse.json({ ok: false, error: 'SLACK_BOT_TOKEN is not set on the server' });
  if (!settings.slackChannelId) return NextResponse.json({ ok: false, error: 'Set a channel id first' });
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { slackUserId: true, name: true } });
  const r = await slack.postMessage({
    channel: settings.slackChannelId,
    text: `:wave: MailFlow test from ${mention(me?.slackUserId, me?.name ?? session.name)} — notifications for assignments and resolutions will post here. <${appUrl('/admin/system-settings')}|System Settings>`,
  });
  await audit(session, 'INTEGRATION_SLACK_TEST', { targetType: 'Organization', targetId: session.organizationId, metadata: { ok: r.ok, error: r.error } });
  return NextResponse.json(r.ok ? { ok: true, ts: r.data?.ts } : { ok: false, error: r.error });
});
