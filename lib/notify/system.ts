import { EmailProvider as EmailProviderEnum, Role, UserStatus, type EmailProviderAccount } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { GmailProvider } from '@/lib/email/gmail';
import { escapeHtml, htmlToPlainText } from '@/lib/templates/variables';
import { SlackClient } from '@/lib/slack/client';

/**
 * Sending path for messages MailFlow sends on its own schedule (digests,
 * reports). There is no shared "noreply" mailbox (§28), so mail goes out
 * from a real connected Gmail: the one chosen in settings, else the
 * organisation's longest-connected mailbox.
 */
export async function systemSenderMailbox(organizationId: string, preferredId: string | null): Promise<EmailProviderAccount | null> {
  if (preferredId) {
    const preferred = await prisma.emailProviderAccount.findFirst({
      where: { id: preferredId, organizationId, provider: EmailProviderEnum.GMAIL, status: 'CONNECTED' },
    });
    if (preferred) return preferred;
  }
  return prisma.emailProviderAccount.findFirst({
    where: { organizationId, provider: EmailProviderEnum.GMAIL, status: 'CONNECTED' },
    orderBy: { createdAt: 'asc' },
  });
}

/** Active users with one of these roles, as lower-cased email addresses. */
export async function emailsForRoles(organizationId: string, roles: Role[]): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { organizationId, role: { in: roles }, status: UserStatus.ACTIVE },
    select: { email: true },
  });
  return users.map((u) => u.email.toLowerCase());
}

export type ChannelOutcome = `SENT${string}` | `SKIPPED: ${string}` | `FAILED: ${string}`;

/** One email to all recipients (BCC keeps addresses private); never throws. */
export async function sendSystemEmail(opts: {
  organizationId: string;
  senderAccountId: string | null;
  to: string[];
  subject: string;
  html: string;
}): Promise<ChannelOutcome> {
  const recipients = [...new Set(opts.to.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (recipients.length === 0) return 'SKIPPED: no recipients';
  const account = await systemSenderMailbox(opts.organizationId, opts.senderAccountId);
  if (!account) return 'SKIPPED: no connected Gmail mailbox to send from';
  try {
    await new GmailProvider(account).sendEmail({
      to: account.emailAddress,
      bcc: recipients,
      fromName: 'MailFlow',
      fromEmail: account.emailAddress,
      subject: opts.subject,
      html: opts.html,
      plainText: htmlToPlainText(opts.html),
    });
    return `SENT to ${recipients.length} from ${account.emailAddress}`;
  } catch (err) {
    return `FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Posts to the organisation's Slack channel (System Settings); never throws. */
export async function postSystemSlack(organizationId: string, text: string): Promise<ChannelOutcome> {
  const slack = SlackClient.fromEnv();
  if (!slack) return 'SKIPPED: Slack is not configured';
  const settings = await prisma.integrationSettings.findUnique({ where: { organizationId }, select: { slackChannelId: true } });
  if (!settings?.slackChannelId) return 'SKIPPED: no Slack channel set in System Settings';
  const res = await slack.postMessage({ channel: settings.slackChannelId, text });
  return res.ok ? 'SENT' : `FAILED: ${res.error ?? 'unknown Slack error'}`;
}

/** Shared email layout for system mail. `body` is trusted HTML built by the caller. */
export function systemEmailShell(title: string, intro: string, body: string): string {
  return [
    `<div style="font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;color:#2d3748;line-height:1.5;max-width:680px">`,
    `<h2 style="margin:0 0 4px;color:#111">${escapeHtml(title)}</h2>`,
    `<p style="margin:0 0 16px;color:#718096;font-size:13px">${escapeHtml(intro)}</p>`,
    body,
    `<p style="margin-top:24px;font-size:12px;color:#718096">Sent by MailFlow · change these emails under Super Admin → System Settings</p>`,
    `</div>`,
  ].join('\n');
}

export function sectionHtml(title: string, count: number, rows: string[], emptyText: string, moreLink?: { href: string; label: string }): string {
  const head = `<h3 style="margin:20px 0 6px;font-size:15px;color:#111">${escapeHtml(title)} <span style="color:${count ? '#ED0331' : '#059669'}">(${count})</span></h3>`;
  if (count === 0) return `${head}<p style="margin:0;color:#059669;font-size:13px">${escapeHtml(emptyText)}</p>`;
  const list = `<ul style="margin:0;padding-left:18px;font-size:13px">${rows.map((r) => `<li style="margin:2px 0">${r}</li>`).join('')}</ul>`;
  const more = moreLink && count > rows.length
    ? `<p style="margin:4px 0 0;font-size:12px"><a href="${escapeHtml(moreLink.href)}">${escapeHtml(moreLink.label)}</a></p>`
    : '';
  return head + list + more;
}
