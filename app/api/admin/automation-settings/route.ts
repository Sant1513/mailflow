import { NextResponse } from 'next/server';
import { z } from 'zod';
import { EmailProvider as EmailProviderEnum, Role, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireRole } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { getOrgSettings, orgSettingsSchema, updateOrgSettings, TRIAGE_INTENTS } from '@/lib/settings/org';
import { collectNeedsAttention, digestTotal } from '@/lib/digest/needsAttention';
import { dispatchDailyReport, dispatchWeeklyReport, SLACK_AS, testReportSlack } from '@/lib/digest/dispatch';
import { collectDailyActivity, latestReportDay, reportWindow, weekWindow } from '@/lib/digest/dailyActivity';
import { renderDailyEmail, renderReportSlack } from '@/lib/digest/dailyEmail';

/**
 * Super Admin → System Settings → Automation: daily digest, weekly report and
 * AI inbox triage. GET returns settings plus the choices the form needs;
 * PUT saves a partial update; POST previews or sends a test to the caller.
 */

async function context(organizationId: string) {
  const [settings, mailboxes, users] = await Promise.all([
    getOrgSettings(organizationId),
    prisma.emailProviderAccount.findMany({
      where: { organizationId, provider: EmailProviderEnum.GMAIL, status: 'CONNECTED' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, emailAddress: true, user: { select: { name: true } } },
    }),
    prisma.user.findMany({
      where: { organizationId, status: UserStatus.ACTIVE },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, role: true },
    }),
  ]);
  return {
    settings,
    mailboxes: mailboxes.map((m) => ({ id: m.id, emailAddress: m.emailAddress, ownerName: m.user?.name ?? null })),
    users,
    intents: TRIAGE_INTENTS,
  };
}

export const GET = withErrorHandling(async () => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  return NextResponse.json(await context(session.organizationId));
});

// Every field optional: the form sends only what changed. Internal markers are never writable.
// Fallback-mailbox opt-ins belong to each mailbox owner (Settings), never to admins.
const putSchema = orgSettingsSchema.omit({ lastDigestOn: true, lastWeeklyReportOn: true, fallbackMailboxes: true }).deepPartial();

export const PUT = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  if (session.viewingAs) return NextResponse.json({ error: 'Read-only while viewing another workspace' }, { status: 403 });
  const body = putSchema.parse(await req.json());
  if (body.senderAccountId) {
    const ok = await prisma.emailProviderAccount.count({ where: { id: body.senderAccountId, organizationId: session.organizationId } });
    if (!ok) return NextResponse.json({ error: 'That mailbox is not in this organisation' }, { status: 400 });
  }
  if (body.triage?.assignByIntent) {
    const ids = Object.values(body.triage.assignByIntent).filter((v): v is string => !!v);
    const found = ids.length ? await prisma.user.count({ where: { id: { in: ids }, organizationId: session.organizationId } }) : 0;
    if (found !== new Set(ids).size) return NextResponse.json({ error: 'An assignee is not in this organisation' }, { status: 400 });
  }
  await updateOrgSettings(session.organizationId, body, session.userId);
  await audit(session, 'AUTOMATION_SETTINGS_UPDATE', { targetType: 'Organization', targetId: session.organizationId, metadata: { sections: Object.keys(body) } });
  return NextResponse.json(await context(session.organizationId));
});

const postSchema = z.object({
  action: z.enum(['preview-digest', 'preview-report', 'test-digest', 'test-report', 'test-slack-digest', 'test-slack-report']),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireRole([Role.SUPER_ADMIN]);
  const { action } = postSchema.parse(await req.json());
  const orgId = session.organizationId;

  if (action === 'preview-digest') {
    const settings = await getOrgSettings(orgId);
    // The latest 8 PM report (today's once 8 PM has passed, else the last working day's).
    const day = latestReportDay(new Date());
    const [data, activity] = await Promise.all([collectNeedsAttention(orgId, settings.digest), collectDailyActivity(orgId, reportWindow(day))]);
    return NextResponse.json({ items: digestTotal(data), day, ...renderDailyEmail(activity, data), slack: { ...renderReportSlack(activity, data), channel: await slackChannelFor(orgId, settings.digest.slackChannel), as: SLACK_AS.daily } });
  }
  if (action === 'preview-report') {
    const settings = await getOrgSettings(orgId);
    // Last week, Monday to Sunday — what Monday morning's email and Slack post will show.
    const [data, activity] = await Promise.all([collectNeedsAttention(orgId, settings.digest), collectDailyActivity(orgId, weekWindow(new Date()))]);
    return NextResponse.json({ ...renderDailyEmail(activity, data), slack: { ...renderReportSlack(activity, data), channel: await slackChannelFor(orgId, settings.weeklyReport.slackChannel), as: SLACK_AS.weekly } });
  }
  if (action === 'test-slack-digest' || action === 'test-slack-report') {
    const outcome = await testReportSlack(orgId, action === 'test-slack-report' ? 'weekly' : 'daily');
    await audit(session, 'REPORT_SLACK_TEST_SENT', { targetType: 'Organization', targetId: orgId, metadata: { action, outcome } });
    return NextResponse.json({ ok: outcome.startsWith('SENT'), outcome });
  }

  const result = action === 'test-digest'
    ? await dispatchDailyReport(orgId, { testTo: session.email })
    : await dispatchWeeklyReport(orgId, { testTo: session.email });
  await audit(session, action === 'test-digest' ? 'DIGEST_TEST_SENT' : 'WEEKLY_REPORT_TEST_SENT', {
    targetType: 'Organization',
    targetId: orgId,
    metadata: { email: result.email },
  });
  return NextResponse.json({ ok: !!result.email?.startsWith('SENT'), outcome: result.email });
});

/** The channel a report posts to: its own, else the notifications channel from System Settings. */
async function slackChannelFor(organizationId: string, own: string): Promise<string | null> {
  if (own) return own;
  const s = await prisma.integrationSettings.findUnique({ where: { organizationId }, select: { slackChannelId: true } });
  return s?.slackChannelId ?? null;
}
