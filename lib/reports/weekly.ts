import { EmailJobStatus, MessageClassification, MessageDirection } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { responseTimeMetrics, responseTimesByUser } from '@/lib/analytics/metrics';
import { appBaseUrl } from '@/lib/app-url';
import { escapeHtml } from '@/lib/templates/variables';
import { systemEmailShell } from '@/lib/notify/system';

/**
 * Weekly leadership report: the last 7 days against the 7 before, for
 * campaigns, e-signature and the inbox. Numbers come straight from the
 * database with explicit [from, to) windows so both weeks are comparable.
 */

export interface WeekNumbers {
  emailsSent: number;
  emailsFailed: number;
  uniqueOpens: number;
  uniqueClicks: number;
  replies: number;
  unsubscribes: number;
  documentsSent: number;
  documentsSigned: number;
  medianHoursToSign: number | null;
  conversationsResolved: number;
}

export interface WeeklyReport {
  from: Date;
  to: Date;
  thisWeek: WeekNumbers;
  lastWeek: WeekNumbers;
  documentsAwaitingSignature: number;
  frtMinutes: number | null;
  artMinutes: number | null;
  topCampaigns: { name: string; sent: number; opens: number; clicks: number; replies: number }[];
  responders: { name: string; responded: number; frtMinutes: number | null }[];
}

const DAY = 86_400_000;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function weekNumbers(organizationId: string, from: Date, to: Date): Promise<WeekNumbers> {
  const range = { gte: from, lt: to };
  const campaignIds = (await prisma.campaign.findMany({ where: { organizationId }, select: { id: true } })).map((c) => c.id);
  const [sent, failed, opens, clicks, replies, unsubscribes, docsSent, signed, resolved] = await Promise.all([
    prisma.emailJob.count({ where: { campaign: { organizationId }, status: EmailJobStatus.SENT, sentAt: range } }),
    prisma.emailJob.count({ where: { campaign: { organizationId }, status: EmailJobStatus.FAILED, lastAttemptAt: range } }),
    campaignIds.length
      ? prisma.emailTrackingEvent.findMany({ where: { campaignId: { in: campaignIds }, type: 'OPEN', createdAt: range }, distinct: ['email'], select: { email: true } })
      : [],
    campaignIds.length
      ? prisma.emailTrackingEvent.findMany({ where: { campaignId: { in: campaignIds }, type: 'CLICK', createdAt: range }, distinct: ['email'], select: { email: true } })
      : [],
    prisma.conversationMessage.count({
      where: { conversation: { organizationId }, direction: MessageDirection.INBOUND, classification: MessageClassification.HUMAN_REPLY, receivedAt: range },
    }),
    prisma.emailSuppression.count({ where: { workspace: { organizationId }, createdAt: range } }),
    prisma.signingRequest.count({ where: { workspace: { organizationId }, sentAt: range } }),
    prisma.signingRequest.findMany({
      where: { workspace: { organizationId }, status: 'SIGNED', signedAt: range },
      select: { sentAt: true, signedAt: true },
    }),
    prisma.conversation.count({ where: { organizationId, status: { in: ['RESOLVED', 'CLOSED'] }, updatedAt: range } }),
  ]);
  const hoursToSign = signed
    .filter((r) => r.sentAt && r.signedAt && r.signedAt > r.sentAt)
    .map((r) => (r.signedAt!.getTime() - r.sentAt!.getTime()) / 3_600_000);
  const med = median(hoursToSign);
  return {
    emailsSent: sent,
    emailsFailed: failed,
    uniqueOpens: opens.length,
    uniqueClicks: clicks.length,
    replies,
    unsubscribes,
    documentsSent: docsSent,
    documentsSigned: signed.length,
    medianHoursToSign: med === null ? null : Math.round(med * 10) / 10,
    conversationsResolved: resolved,
  };
}

export async function buildWeeklyReport(organizationId: string, now: Date = new Date()): Promise<WeeklyReport> {
  const to = now;
  const from = new Date(to.getTime() - 7 * DAY);
  const prevFrom = new Date(from.getTime() - 7 * DAY);

  const [thisWeek, lastWeek, awaiting, rt, byUser, campaigns] = await Promise.all([
    weekNumbers(organizationId, from, to),
    weekNumbers(organizationId, prevFrom, from),
    prisma.signingRequest.count({ where: { workspace: { organizationId }, status: { in: ['SENT', 'VIEWED'] } } }),
    responseTimeMetrics({ organizationId }, 7, now),
    responseTimesByUser(organizationId, 7, now),
    prisma.campaign.findMany({
      where: { organizationId, emailJobs: { some: { sentAt: { gte: from, lt: to } } } },
      select: { id: true, name: true },
      take: 50,
    }),
  ]);

  const topCampaigns = await Promise.all(
    campaigns.map(async (c) => {
      const [sent, opens, clicks, replies] = await Promise.all([
        prisma.emailJob.count({ where: { campaignId: c.id, status: EmailJobStatus.SENT, sentAt: { gte: from, lt: to } } }),
        prisma.emailTrackingEvent.findMany({ where: { campaignId: c.id, type: 'OPEN', createdAt: { gte: from, lt: to } }, distinct: ['email'], select: { email: true } }),
        prisma.emailTrackingEvent.findMany({ where: { campaignId: c.id, type: 'CLICK', createdAt: { gte: from, lt: to } }, distinct: ['email'], select: { email: true } }),
        prisma.emailJob.count({ where: { campaignId: c.id, sentAt: { gte: from, lt: to }, record: { replyReceived: true } } }),
      ]);
      return { name: c.name, sent, opens: opens.length, clicks: clicks.length, replies };
    }),
  );

  return {
    from,
    to,
    thisWeek,
    lastWeek,
    documentsAwaitingSignature: awaiting,
    frtMinutes: rt.frtMinutes,
    artMinutes: rt.artMinutes,
    topCampaigns: topCampaigns.sort((a, b) => b.sent - a.sent).slice(0, 5),
    responders: byUser
      .filter((u) => u.respondedConversations > 0)
      .sort((a, b) => b.respondedConversations - a.respondedConversations)
      .slice(0, 8)
      .map((u) => ({ name: u.userName ?? u.userEmail, responded: u.respondedConversations, frtMinutes: u.frtMinutes })),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} days`;
}

function delta(now: number, before: number, higherIsBetter = true): string {
  if (now === before) return '<span style="color:#718096">no change</span>';
  const up = now > before;
  const good = up === higherIsBetter;
  const change = before === 0 ? `+${now}` : `${up ? '+' : ''}${Math.round(((now - before) / before) * 100)}%`;
  return `<span style="color:${good ? '#059669' : '#ED0331'}">${up ? '▲' : '▼'} ${change}</span>`;
}

function metricRow(label: string, value: string, change: string): string {
  return `<tr><td style="padding:6px 16px 6px 0;color:#4a5568">${escapeHtml(label)}</td><td style="padding:6px 16px 6px 0;font-weight:700;color:#111">${escapeHtml(value)}</td><td style="padding:6px 0;font-size:12px">${change}</td></tr>`;
}

const table = (rows: string) => `<table style="border-collapse:collapse;margin:4px 0 8px;font-size:14px">${rows}</table>`;
const h3 = (t: string) => `<h3 style="margin:20px 0 4px;font-size:15px;color:#111">${escapeHtml(t)}</h3>`;

export function renderWeeklyReportEmail(r: WeeklyReport): { subject: string; html: string } {
  const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const range = `${fmt(r.from)} – ${fmt(new Date(r.to.getTime() - 1))}`;
  const t = r.thisWeek;
  const l = r.lastWeek;
  const base = appBaseUrl();

  const campaigns = table(
    metricRow('Emails sent', String(t.emailsSent), delta(t.emailsSent, l.emailsSent)) +
      metricRow('Open rate', pct(t.uniqueOpens, t.emailsSent), delta(t.uniqueOpens, l.uniqueOpens)) +
      metricRow('Click rate', pct(t.uniqueClicks, t.emailsSent), delta(t.uniqueClicks, l.uniqueClicks)) +
      metricRow('Student replies', String(t.replies), delta(t.replies, l.replies)) +
      metricRow('Failed sends', String(t.emailsFailed), delta(t.emailsFailed, l.emailsFailed, false)) +
      metricRow('Unsubscribes', String(t.unsubscribes), delta(t.unsubscribes, l.unsubscribes, false)),
  );
  const signing = table(
    metricRow('Documents sent', String(t.documentsSent), delta(t.documentsSent, l.documentsSent)) +
      metricRow('Documents signed', String(t.documentsSigned), delta(t.documentsSigned, l.documentsSigned)) +
      metricRow('Median time to sign', t.medianHoursToSign === null ? '—' : duration(Math.round(t.medianHoursToSign * 60)),
        t.medianHoursToSign === null || l.medianHoursToSign === null ? '' : delta(t.medianHoursToSign, l.medianHoursToSign, false)) +
      metricRow('Awaiting signature now', String(r.documentsAwaitingSignature), ''),
  );
  const inbox = table(
    metricRow('First response time (avg)', duration(r.frtMinutes), '') +
      metricRow('Response time (avg)', duration(r.artMinutes), '') +
      metricRow('Conversations resolved', String(t.conversationsResolved), delta(t.conversationsResolved, l.conversationsResolved)),
  );
  const top = r.topCampaigns.length
    ? `<table style="border-collapse:collapse;font-size:13px;margin:4px 0"><tr style="color:#718096;text-align:left"><th style="padding:4px 12px 4px 0">Campaign</th><th style="padding:4px 12px 4px 0">Sent</th><th style="padding:4px 12px 4px 0">Opened</th><th style="padding:4px 12px 4px 0">Clicked</th><th style="padding:4px 0">Replied</th></tr>${r.topCampaigns
        .map((c) => `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(c.name)}</td><td style="padding:4px 12px 4px 0">${c.sent}</td><td style="padding:4px 12px 4px 0">${pct(c.opens, c.sent)}</td><td style="padding:4px 12px 4px 0">${pct(c.clicks, c.sent)}</td><td style="padding:4px 0">${c.replies}</td></tr>`)
        .join('')}</table>`
    : '<p style="margin:0;color:#718096;font-size:13px">No campaigns sent this week.</p>';
  const people = r.responders.length
    ? `<table style="border-collapse:collapse;font-size:13px;margin:4px 0"><tr style="color:#718096;text-align:left"><th style="padding:4px 12px 4px 0">Person</th><th style="padding:4px 12px 4px 0">Conversations answered</th><th style="padding:4px 0">First response</th></tr>${r.responders
        .map((p) => `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(p.name)}</td><td style="padding:4px 12px 4px 0">${p.responded}</td><td style="padding:4px 0">${duration(p.frtMinutes)}</td></tr>`)
        .join('')}</table>`
    : '<p style="margin:0;color:#718096;font-size:13px">No replies were answered this week.</p>';

  const body = [
    h3('Campaigns'), campaigns,
    h3('E-signature'), signing,
    h3('Inbox'), inbox,
    h3('Top campaigns this week'), top,
    h3('Who answered students'), people,
    `<p style="margin-top:16px;font-size:13px"><a href="${escapeHtml(`${base}/reports`)}">Open the full reports in MailFlow</a></p>`,
  ].join('\n');

  return {
    subject: `[MailFlow] Weekly report · ${range}`,
    html: systemEmailShell('Weekly report', `${range} compared with the week before`, body),
  };
}

export function renderWeeklyReportSlack(r: WeeklyReport): string {
  const t = r.thisWeek;
  return [
    ':bar_chart: *MailFlow weekly report*',
    `• Emails sent *${t.emailsSent}* (open ${pct(t.uniqueOpens, t.emailsSent)}, click ${pct(t.uniqueClicks, t.emailsSent)}), replies *${t.replies}*`,
    `• Documents sent *${t.documentsSent}*, signed *${t.documentsSigned}*, awaiting *${r.documentsAwaitingSignature}*`,
    `• First response *${duration(r.frtMinutes)}*, resolved *${t.conversationsResolved}*`,
    `<${appBaseUrl()}/reports|Full report>`,
  ].join('\n');
}
