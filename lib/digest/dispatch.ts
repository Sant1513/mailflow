import { Role } from '@prisma/client';
import { getOrgSettings, updateOrgSettings } from '@/lib/settings/org';
import { emailsForRoles, postSystemSlack, sendSystemEmail, type ChannelOutcome } from '@/lib/notify/system';
import { collectNeedsAttention, digestTotal, renderDigestEmail, renderDigestSlack } from '@/lib/digest/needsAttention';
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
 * Sends the daily digest for one organisation. Scheduled runs send at most
 * once per IST day and stay quiet when nothing needs attention; a test run
 * (`testTo`) always sends, to that one address only, and never touches Slack
 * or the once-a-day marker.
 */
export async function dispatchDigest(organizationId: string, opts: { testTo?: string; now?: Date } = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const settings = await getOrgSettings(organizationId);
  const today = istDate(now);
  if (!opts.testTo) {
    if (!settings.digest.enabled) return { organizationId, sent: false, reason: 'digest turned off' };
    if (settings.lastDigestOn === today) return { organizationId, sent: false, reason: 'already sent today' };
  }

  const data = await collectNeedsAttention(organizationId, settings.digest, now);
  const items = digestTotal(data);
  if (!opts.testTo && items === 0) {
    await updateOrgSettings(organizationId, { lastDigestOn: today }, 'system');
    return { organizationId, sent: false, reason: 'nothing needs attention', items };
  }

  const { subject, html } = renderDigestEmail(data);
  const to = opts.testTo
    ? [opts.testTo]
    : [...(settings.digest.emailAdmins ? await emailsForRoles(organizationId, [Role.SUPER_ADMIN, Role.ADMIN]) : []), ...settings.digest.extraEmails];
  const email = await sendSystemEmail({ organizationId, senderAccountId: settings.senderAccountId, to, subject: opts.testTo ? `[Test] ${subject}` : subject, html });
  const slack = !opts.testTo && settings.digest.slack ? await postSystemSlack(organizationId, renderDigestSlack(data)) : undefined;

  if (!opts.testTo) await updateOrgSettings(organizationId, { lastDigestOn: today }, 'system');
  return { organizationId, sent: email.startsWith('SENT') || !!slack?.startsWith('SENT'), items, email, slack };
}

/** Sends the weekly report; same once-per-day and test rules as the digest. */
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
