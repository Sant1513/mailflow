import { Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getOrgSettings } from '@/lib/settings/org';
import { emailsForRoles, postReportImage, postSystemSlack, sendSystemEmail, type ChannelOutcome } from '@/lib/notify/system';
import { collectNeedsAttention, digestTotal, type NeedsAttention } from '@/lib/digest/needsAttention';
import { collectDailyActivity, type DailyActivity, dueReportDay, latestReportDay, reportWindow, weekWindow } from '@/lib/digest/dailyActivity';
import { dailyLabel, renderDailyEmail, renderReportSlack } from '@/lib/digest/dailyEmail';
import { renderReportImage } from '@/lib/digest/reportImage';
import { appBaseUrl } from '@/lib/app-url';

/**
 * The report in Slack: one picture with everything in it and a one-line message above it.
 * If Slack won't take the picture (missing files:write permission) or it can't be drawn, the
 * old text report goes out instead, so a report is never lost.
 */
async function postReport(organizationId: string, kind: 'daily' | 'weekly', a: DailyActivity, d: NeedsAttention, channel: string | undefined, test = false): Promise<ChannelOutcome> {
  const msg = renderReportSlack(a, d, { test });
  const fallback = () => postSystemSlack(organizationId, msg.text, { channel, blocks: msg.blocks, ...SLACK_AS[kind] });
  try {
    const img = await renderReportImage(a, d, { test });
    const t = a.totals;
    const fromYmd = new Date(a.from.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const link = `${appBaseUrl()}/admin/organization?lfrom=${fromYmd}&lto=${a.ymd}`;
    const text = `*${test ? '[Test] ' : ''}${kind === 'weekly' ? 'Weekly' : 'Daily'} report · ${dailyLabel(a)}*
${t.emails.toLocaleString('en-IN')} emails · ${t.failed.toLocaleString('en-IN')} failed · ${a.inboxTotal.received.toLocaleString('en-IN')} replies · <${link}|Open dashboard>`;
    return await postReportImage(organizationId, { channel, text, filename: `mailflow-${kind}-report-${a.ymd}.png`, bytes: img.bytes, fallback });
  } catch {
    return fallback();
  }
}

/** Today's date in India (YYYY-MM-DD), the unit for "once a day". */
export function istDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The name and icon the reports post under in Slack. */
export const SLACK_AS = {
  daily: { username: 'MailFlow Daily Report', iconEmoji: ':bar_chart:' },
  weekly: { username: 'MailFlow Weekly Report', iconEmoji: ':calendar:' },
} as const;

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
    const slack = !opts.testTo && settings.digest.slack ? await postReport(organizationId, 'daily', activity, needs, settings.digest.slackChannel) : undefined;
    // Nothing went out: release the day so the next run tries again.
    if (!opts.testTo && !email.startsWith('SENT') && !slack?.startsWith('SENT')) await releaseReportDay(organizationId, day, settings.lastDailyReportOn);
    return { organizationId, sent: email.startsWith('SENT') || !!slack?.startsWith('SENT'), items, email, slack, reason: `report for ${day}` };
  } catch (err) {
    if (!opts.testTo) await releaseReportDay(organizationId, day, settings.lastDailyReportOn).catch(() => undefined);
    throw err;
  }
}

/** The once-a-day markers in IntegrationSettings.settings (a fixed list: they go into the SQL). */
type ReportMarker = 'lastDailyReportOn' | 'lastWeeklyReportOn';
const MARKERS: Record<ReportMarker, { path: Prisma.Sql; key: Prisma.Sql }> = {
  lastDailyReportOn: { path: Prisma.raw(`'{lastDailyReportOn}'`), key: Prisma.raw(`'lastDailyReportOn'`) },
  lastWeeklyReportOn: { path: Prisma.raw(`'{lastWeeklyReportOn}'`), key: Prisma.raw(`'lastWeeklyReportOn'`) },
};

/** Marks `day` as sent, only if it isn't already (one atomic UPDATE). True = this run sends it. */
async function claimReportDay(organizationId: string, day: string, marker: ReportMarker = 'lastDailyReportOn'): Promise<boolean> {
  const m = MARKERS[marker];
  await prisma.integrationSettings.upsert({ where: { organizationId }, update: {}, create: { organizationId, settings: {} } });
  const n = await prisma.$executeRaw`
    UPDATE "IntegrationSettings"
    SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), ${m.path}, to_jsonb(${day}::text)), "updatedAt" = now()
    WHERE "organizationId" = ${organizationId} AND COALESCE("settings"->>${m.key}, '') <> ${day}`;
  return n > 0;
}

async function releaseReportDay(organizationId: string, day: string, previous: string | null, marker: ReportMarker = 'lastDailyReportOn'): Promise<void> {
  const m = MARKERS[marker];
  await prisma.$executeRaw`
    UPDATE "IntegrationSettings"
    SET "settings" = jsonb_set("settings", ${m.path}, ${previous === null ? Prisma.sql`'null'::jsonb` : Prisma.sql`to_jsonb(${previous}::text)`})
    WHERE "organizationId" = ${organizationId} AND "settings"->>${m.key} = ${day}`;
}

/**
 * The weekly report, Monday morning: last week, Monday to Sunday, in the same design as the
 * daily report (day by day, compared with the week before). Once per IST day; a test goes to
 * one address only and never touches Slack or the marker.
 */
export async function dispatchWeeklyReport(organizationId: string, opts: { testTo?: string; now?: Date } = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const settings = await getOrgSettings(organizationId);
  const today = istDate(now);
  if (!opts.testTo) {
    if (!settings.weeklyReport.enabled) return { organizationId, sent: false, reason: 'weekly report turned off' };
    if (settings.lastWeeklyReportOn === today) return { organizationId, sent: false, reason: 'already sent today' };
    // Claimed before sending, like the daily report, so the Vercel cron and the laptop can't
    // both send it; released again if nothing went out, so a later run retries.
    if (!(await claimReportDay(organizationId, today, 'lastWeeklyReportOn'))) return { organizationId, sent: false, reason: 'already sent today' };
  }

  try {
    const [needs, activity] = await Promise.all([collectNeedsAttention(organizationId, settings.digest, now), collectDailyActivity(organizationId, weekWindow(now))]);
    const { subject, html } = renderDailyEmail(activity, needs);
    const to = opts.testTo
      ? [opts.testTo]
      : [...(settings.weeklyReport.emailSuperAdmins ? await emailsForRoles(organizationId, [Role.SUPER_ADMIN]) : []), ...settings.weeklyReport.extraEmails];
    const email = await sendSystemEmail({ organizationId, senderAccountId: settings.senderAccountId, to, visible: !!opts.testTo, subject: opts.testTo ? `[Test] ${subject}` : subject, html });
    const slack = !opts.testTo && settings.weeklyReport.slack ? await postReport(organizationId, 'weekly', activity, needs, settings.weeklyReport.slackChannel) : undefined;

    const sent = email.startsWith('SENT') || !!slack?.startsWith('SENT');
    // Nothing went out: release the day so the next run tries again.
    if (!opts.testTo && !sent) await releaseReportDay(organizationId, today, settings.lastWeeklyReportOn, 'lastWeeklyReportOn');
    return { organizationId, sent, email, slack };
  } catch (err) {
    if (!opts.testTo) await releaseReportDay(organizationId, today, settings.lastWeeklyReportOn, 'lastWeeklyReportOn').catch(() => undefined);
    throw err;
  }
}

/** Posts a test of a report to its Slack channel (marked [Test]); nothing else is sent or marked. */
export async function testReportSlack(organizationId: string, kind: 'daily' | 'weekly', now: Date = new Date()): Promise<ChannelOutcome> {
  const settings = await getOrgSettings(organizationId);
  const window = kind === 'weekly' ? weekWindow(now) : reportWindow(latestReportDay(now));
  const [needs, activity] = await Promise.all([collectNeedsAttention(organizationId, settings.digest, now), collectDailyActivity(organizationId, window)]);
  return postReport(organizationId, kind, activity, needs, kind === 'weekly' ? settings.weeklyReport.slackChannel : settings.digest.slackChannel, true);
}
