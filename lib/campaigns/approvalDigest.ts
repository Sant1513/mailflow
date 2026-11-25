import { CampaignStatus, Role, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getOrgSettings, updateOrgSettings } from '@/lib/settings/org';
import { escapeHtml, htmlToPlainText } from '@/lib/templates/variables';
import { emailsForRoles, sendSystemEmail } from '@/lib/notify/system';
import { appUrl } from '@/lib/campaigns/approvalEmails';

/**
 * The summary email for approvals (System Settings → Approvals → "one summary email"): instead of one email per request and
 * one per decision, the approvers get ONE email listing everything that is waiting. It goes out only when
 *   - the organisation chose DIGEST,
 *   - something is waiting that the last summary did not list, or the same things are still waiting after a day (a reminder),
 *   - and at least `digestMinutes` have passed since the last one.
 * Requests and decisions are always in the app (bell and the Approvals badge) whatever this says.
 */
const DAY_MS = 86_400_000;

export interface PendingLine { id: string; name: string; requester: string; recipients: number; waitingMinutes: number }

/** Pure decision: should a summary go out now? */
export function digestDue(input: { notify: string; digestMinutes: number; lastDigestAt: string | null; lastDigestIds: string[]; pendingIds: string[]; now: Date }): { send: boolean; reason: string } {
  if (input.notify !== 'DIGEST') return { send: false, reason: 'summary emails are off' };
  if (!input.pendingIds.length) return { send: false, reason: 'nothing is waiting' };
  const last = input.lastDigestAt ? new Date(input.lastDigestAt).getTime() : 0;
  const since = input.now.getTime() - last;
  if (since < input.digestMinutes * 60_000) return { send: false, reason: 'too soon after the last summary' };
  const seen = new Set(input.lastDigestIds);
  const hasNew = input.pendingIds.some((id) => !seen.has(id));
  if (hasNew) return { send: true, reason: 'new requests are waiting' };
  if (since >= DAY_MS) return { send: true, reason: 'daily reminder: the same requests are still waiting' };
  return { send: false, reason: 'nothing new since the last summary' };
}

export function renderApprovalDigest(lines: PendingLine[]): { subject: string; html: string } {
  const n = lines.length;
  const wait = (m: number) => (m < 60 ? `${Math.max(1, m)} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);
  const rows = lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 12px 6px 0"><a href="${escapeHtml(appUrl(`/campaigns/${l.id}`))}" style="color:#111;font-weight:600;text-decoration:none">${escapeHtml(l.name)}</a></td><td style="padding:6px 12px 6px 0;color:#4a5568">${escapeHtml(l.requester)}</td><td style="padding:6px 12px 6px 0;text-align:right;color:#4a5568">${l.recipients}</td><td style="padding:6px 0;color:#718096;white-space:nowrap">${wait(l.waitingMinutes)}</td></tr>`,
    )
    .join('');
  const html = [
    `<div style="font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;color:#2d3748;line-height:1.5;max-width:680px">`,
    `<h2 style="margin:0 0 8px;color:#111">${n} campaign${n === 1 ? '' : 's'} waiting for approval</h2>`,
    `<p style="margin:0 0 12px">Nothing is sent until an admin approves it. This is one summary instead of an email for every request.</p>`,
    `<table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="text-align:left;color:#718096;font-size:12px"><th style="padding:4px 12px 4px 0">Campaign</th><th style="padding:4px 12px 4px 0">Requested by</th><th style="padding:4px 12px 4px 0;text-align:right">Recipients</th><th style="padding:4px 0">Waiting</th></tr>${rows}</table>`,
    `<p style="margin-top:16px"><a href="${escapeHtml(appUrl('/approvals'))}" style="display:inline-block;background:#111;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">Open Approvals</a></p>`,
    `<p style="margin-top:24px;font-size:12px;color:#718096">Sent by MailFlow. You can change how often, or switch these emails off, in System Settings → Approvals.</p>`,
    `</div>`,
  ].join('\n');
  return { subject: `[MailFlow] ${n} campaign${n === 1 ? '' : 's'} waiting for approval`, html };
}

export interface ApprovalDigestResult { organizationId: string; sent: boolean; reason: string; pending?: number; email?: string }

export async function sendApprovalDigest(organizationId: string, now: Date = new Date()): Promise<ApprovalDigestResult> {
  const settings = await getOrgSettings(organizationId);
  const a = settings.approvals;
  if (a.notify !== 'DIGEST') return { organizationId, sent: false, reason: 'summary emails are off' };

  const pending = await prisma.campaign.findMany({
    where: { organizationId, status: CampaignStatus.PENDING_APPROVAL },
    orderBy: { submittedAt: 'asc' },
    take: 100,
    select: { id: true, name: true, submittedAt: true, createdAt: true, createdBy: { select: { name: true } }, _count: { select: { campaignRecords: true } } },
  });
  const due = digestDue({ notify: a.notify, digestMinutes: a.digestMinutes, lastDigestAt: a.lastDigestAt, lastDigestIds: a.lastDigestIds, pendingIds: pending.map((p) => p.id), now });
  if (!due.send) return { organizationId, sent: false, reason: due.reason, pending: pending.length };

  const to = await emailsForRoles(organizationId, [Role.SUPER_ADMIN, Role.ADMIN]);
  if (!to.length) return { organizationId, sent: false, reason: 'no approvers to email', pending: pending.length };

  // Claim the slot first so a second run a moment later does not send it again; put it back if nothing went out.
  const previous = { lastDigestAt: a.lastDigestAt, lastDigestIds: a.lastDigestIds };
  await updateOrgSettings(organizationId, { approvals: { lastDigestAt: now.toISOString(), lastDigestIds: pending.map((p) => p.id).slice(0, 300) } }, 'system');
  const { subject, html } = renderApprovalDigest(
    pending.map((p) => ({ id: p.id, name: p.name, requester: p.createdBy.name, recipients: p._count.campaignRecords, waitingMinutes: Math.max(0, Math.round((now.getTime() - (p.submittedAt ?? p.createdAt).getTime()) / 60_000)) })),
  );
  const email = await sendSystemEmail({ organizationId, senderAccountId: settings.senderAccountId, to, visible: true, subject, html });
  if (!email.startsWith('SENT')) {
    await updateOrgSettings(organizationId, { approvals: previous }, 'system').catch(() => undefined);
    return { organizationId, sent: false, reason: `not sent: ${email}`, pending: pending.length, email };
  }
  void htmlToPlainText;
  return { organizationId, sent: true, reason: due.reason, pending: pending.length, email };
}

/** Approvers' count, for the settings page ("N people get the summary"). */
export async function approverCount(organizationId: string): Promise<number> {
  return prisma.user.count({ where: { organizationId, status: UserStatus.ACTIVE, role: { in: [Role.SUPER_ADMIN, Role.ADMIN] } } });
}
