import { Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getOrgSettings, updateOrgSettings } from '@/lib/settings/org';
import { emailsForRoles, postSystemSlack, sendSystemEmail, type ChannelOutcome } from '@/lib/notify/system';
import { collectNeedsAttention, digestTotal, renderDigestSlack } from '@/lib/digest/needsAttention';
import { collectDailyActivity, dueReportDay, latestReportDay, reportWindow } from '@/lib/digest/dailyActivity';
import { renderDailyEmail, renderDailySlackLine } from '@/lib/digest/dailyEmail';
import { buildWeeklyReport, renderWeeklyReportEmail, renderWeeklyReportSlack } from '@/lib/reports/weekly';

/** Today's date in India (YYYY-MM-DD), the unit for "once a day". */
export function istDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface DispatchResult {
  organizationId: string;
  sent: boolean;
  reason?: string;
  items?: number;
  email?: ChannelOutcome;
  slack?: ChannelOutcome;
}

/**
 * The daily report, 8 PM IST, Monday to Friday (replaces the 09:00 "needs attention" digest):
 * everything since the last report (8 PM → 8 PM; Monday includes the weekend), each person's
 * inbox, and what needs attention. Sent once per working day: the day is claimed in the
 * database before sending, so the GitHub schedule, the Vercel cron and the laptop can all
 * try without sending twice. A test (`testTo`) goes to that one address only and never
 * touches Slack or the once-a-day marker.
 */
export async function dispatchDailyReport(organizationId: string, opts: { testTo?: string; now?: Date; day?: string } = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const settings = await getOrgSettings(organizationId);
  const day = opts.day ?? (opts.testTo ? latestReportDay(now) : dueReportDay(now));
  if (!day) return { organizationId, sent: false, reason: 'not report time (8 PM IST, Monday to Friday)' };
  if (!opts.testTo) {
    if (!settings.digest.enabled) return { organizationId, sent: false, reason: 'daily report turned off' };
    if (settings.lastDailyReportOn === day) return { organizationId, sent: false, reason: `already sent for ${day}` };
    if (!(await claimReportDay(organizationId, day))) return { organizationId, sent: false, reason: `already sent for ${day}` };
  }

  try {
    const window = reportWindow(day);
    const [needs, activity] = await Promise.all([collectNeedsAttention(organizationId, settings.digest, now), collectDailyActivity(organizationId, window)]);
    const items = digestTotal(needs);
    const { subject, html } = renderDailyEmail(activity, needs);
    const visible = settings.digest.to.length > 0;
    const to = opts.testTo
      ? [opts.testTo]
      : visible
        ? settings.digest.to
        : [...(settings.digest.emailAdmins ? await emailsForRoles(organizationId, [Role.SUPER_ADMIN, Role.ADMIN]) : []), ...settings.digest.extraEmails];
    const email = await sendSystemEmail({
      organizationId,
      senderAccountId: settings.senderAccountId,
      to,
      cc: opts.testTo ? [] : settings.digest.cc,
      visible: !!opts.testTo || visible,
      subject: opts.testTo ? `[Test] ${subject}` : subject,
      html,
    });
    const slack = !opts.testTo && settings.digest.slack ? await postSystemSlack(organizationId, `${renderDailySlackLine(activity)}\n\n${renderDigestSlack(needs)}`) : undefined;
    // Nothing went out: release the day so the next run tries again.
    if (!opts.testTo && !email.startsWith('SENT') && !slack?.startsWith('SENT')) await releaseReportDay(organizationId, day, settings.lastDailyReportOn);
    return { organizationId, sent: email.startsWith('SENT') || !!slack?.startsWith('SENT'), items, email, slack, reason: `report for ${day}` };
  } catch (err) {
    if (!opts.testTo) await releaseReportDay(organizationId, day, settings.lastDailyReportOn).catch(() => undefined);
    throw err;
  }
}

/** Marks `day` as sent, only if it isn't already (one atomic UPDATE). True = this run sends it. */
async function claimReportDay(organizationId: string, day: string): Promise<boolean> {
  await prisma.integrationSettings.upsert({ where: { organizationId }, update: {}, create: { organizationId, settings: {} } });
  const n = await prisma.$executeRaw`
    UPDATE "IntegrationSettings"
    SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), '{lastDailyReportOn}', to_jsonb(${day}::text)), "updatedAt" = now()
    WHERE "organizationId" = ${organizationId} AND COALESCE("settings"->>'lastDailyReportOn', '') <> ${day}`;
  return n > 0;
}

async function releaseReportDay(organizationId: string, day: string, previous: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "IntegrationSettings"
    SET "settings" = jsonb_set("settings", '{lastDailyReportOn}', ${previous === null ? Prisma.sql`'null'::jsonb` : Prisma.sql`to_jsonb(${previous}::text)`})
    WHERE "organizationId" = ${organizationId} AND "settings"->>'lastDailyReportOn' = ${day}`;
}

/** Sends the weekly report: once per IST day, and a test goes to one address only. */
export async function dispatchWeeklyReport(organizationId: string, opts: { testTo?: string; now?: Date } = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const settings = await getOrgSettings(organizationId);
  const today = istDate(now);
  if (!opts.testTo) {
    if (!settings.weeklyReport.enabled) return { organizationId, sent: false, reason: 'weekly report turned off' };
    if (settings.lastWeeklyReportOn === today) return { organizationId, sent: false, reason: 'already sent today' };
  }

  const report = await buildWeeklyReport(organizationId, now);
  const { subject, html } = renderWeeklyReportEmail(report);
  const to = opts.testTo
    ? [opts.testTo]
    : [...(settings.weeklyReport.emailSuperAdmins ? await emailsForRoles(organizationId, [Role.SUPER_ADMIN]) : []), ...settings.weeklyReport.extraEmails];
  const email = await sendSystemEmail({ organizationId, senderAccountId: settings.senderAccountId, to, subject: opts.testTo ? `[Test] ${subject}` : subject, html });
  const slack = !opts.testTo && settings.weeklyReport.slack ? await postSystemSlack(organizationId, renderWeeklyReportSlack(report)) : undefined;

  if (!opts.testTo) await updateOrgSettings(organizationId, { lastWeeklyReportOn: today }, 'system');
  return { organizationId, sent: email.startsWith('SENT') || !!slack?.startsWith('SENT'), email, slack };
}
