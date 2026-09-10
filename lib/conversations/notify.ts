import { prisma } from '@/lib/db/client';
import { GmailProvider } from '@/lib/email/gmail';
import { buildReferences } from '@/lib/email/mime';
import { SendEmailError } from '@/lib/email/provider';
import { SlackClient, esc, mention } from '@/lib/slack/client';
import { escapeHtml, htmlToPlainText } from '@/lib/templates/variables';
import { appUrl } from '@/lib/campaigns/approvalEmails';
import { audit } from '@/lib/audit/log';
import type { AppSession } from '@/lib/auth/session';
import { EmailProvider as EmailProviderEnum } from '@prisma/client';

/**
 * §57/§87 assignment and resolution notifications, in ONE email thread and
 * ONE Slack thread per conversation:
 *
 *   assign   → email the assignee from the assigner's mailbox (fallback: the
 *              conversation's mailbox), Cc the assigner; post to the Slack
 *              channel mentioning the assignee. Ids stored on the conversation.
 *   resolve  → reply in that email thread and in that Slack thread. If no
 *              thread exists yet, start one rather than stay silent.
 *
 * Everything is best effort and records its outcome: a missing mailbox,
 * a missing Slack id or a Slack outage never blocks the change.
 */

export interface NotifyOutcome {
  email: string;
  slack: string;
  inApp: string;
}

interface ConversationForNotify {
  id: string;
  subject: string;
  recipientEmail: string;
  workspaceId: string;
  organizationId: string;
  emailProviderAccountId: string;
  assigneeId: string | null;
  notifyEmailAccountId: string | null;
  notifyEmailMessageId: string | null;
  notifyEmailThreadId: string | null;
  notifySlackChannelId: string | null;
  notifySlackThreadTs: string | null;
  contact: { name: string | null };
  messages: { direction: string; snippet: string | null; plainTextBody: string | null; senderName: string | null; sentAt: Date | null; receivedAt: Date | null; createdAt: Date }[];
}

function lastMessageLine(c: ConversationForNotify): string {
  const last = [...c.messages].sort((a, b) => (b.sentAt ?? b.receivedAt ?? b.createdAt).getTime() - (a.sentAt ?? a.receivedAt ?? a.createdAt).getTime())[0];
  if (!last) return '';
  const who = last.direction === 'INBOUND' ? last.senderName || c.recipientEmail : 'Team';
  const text = (last.snippet || last.plainTextBody || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return text ? `${who}: ${text}` : '';
}

async function loadConversation(id: string): Promise<ConversationForNotify | null> {
  return prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true, subject: true, recipientEmail: true, workspaceId: true, organizationId: true, emailProviderAccountId: true, assigneeId: true,
      notifyEmailAccountId: true, notifyEmailMessageId: true, notifyEmailThreadId: true, notifySlackChannelId: true, notifySlackThreadTs: true,
      contact: { select: { name: true } },
      messages: { select: { direction: true, snippet: true, plainTextBody: true, senderName: true, sentAt: true, receivedAt: true, createdAt: true } },
    },
  });
}

async function integration(organizationId: string) {
  return prisma.integrationSettings.findUnique({ where: { organizationId } });
}

async function mailboxFor(workspaceId: string, userId: string) {
  return prisma.emailProviderAccount.findUnique({ where: { workspaceId_userId_provider: { workspaceId, userId, provider: EmailProviderEnum.GMAIL } } });
}

function describeError(err: unknown): string {
  if (err instanceof SendEmailError) return `${err.kind}: ${err.message}`.slice(0, 200);
  return ((err as Error)?.message ?? 'unknown error').slice(0, 200);
}

// ── message builders (pure, tested) ──────────────────────────────────────

export function assignmentSubject(subject: string): string {
  return `[MailFlow] Assigned to you: ${subject || '(no subject)'}`;
}

export function assignmentEmailHtml(i: { assigneeName: string; assignerName: string; subject: string; student: string; lastLine: string; url: string }): string {
  return [
    `<div style="font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;color:#2d3748;line-height:1.5;max-width:640px">`,
    `<p>Hi ${escapeHtml(i.assigneeName.split(' ')[0] ?? i.assigneeName)},</p>`,
    `<p><strong>${escapeHtml(i.assignerName)}</strong> assigned you the conversation <strong>${escapeHtml(i.subject || '(no subject)')}</strong> with ${escapeHtml(i.student)}.</p>`,
    i.lastLine ? `<p style="border-left:3px solid #ED0331;padding:8px 12px;background:#fff5f6;color:#4a5568">${escapeHtml(i.lastLine)}</p>` : '',
    `<p><a href="${escapeHtml(i.url)}" style="display:inline-block;background:#ED0331;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Open in MailFlow</a></p>`,
    `<p style="font-size:12px;color:#718096">Replies to this thread stay between you and ${escapeHtml(i.assignerName)}; the student is not on it.</p>`,
    `</div>`,
  ].join('\n');
}

export function resolutionEmailHtml(i: { assigneeName: string; actorName: string; subject: string; status: string; url: string }): string {
  const verb = i.status === 'CLOSED' ? 'closed' : 'resolved';
  return [
    `<div style="font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;color:#2d3748;line-height:1.5;max-width:640px">`,
    `<p>Hi ${escapeHtml(i.assigneeName.split(' ')[0] ?? i.assigneeName)},</p>`,
    `<p><strong>${escapeHtml(i.actorName)}</strong> marked <strong>${escapeHtml(i.subject || '(no subject)')}</strong> as <strong style="color:#059669">${verb}</strong>.</p>`,
    `<p><a href="${escapeHtml(i.url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Open in MailFlow</a></p>`,
    `</div>`,
  ].join('\n');
}

export function assignmentSlackText(i: { assigneeSlackId: string | null; assigneeName: string; assignerName: string; subject: string; student: string; lastLine: string; url: string }): string {
  return [
    `:inbox_tray: ${mention(i.assigneeSlackId, esc(i.assigneeName))} — *${esc(i.assignerName)}* assigned you <${i.url}|${esc(i.subject || '(no subject)')}> with ${esc(i.student)}.`,
    i.lastLine ? `> ${esc(i.lastLine)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function resolutionSlackText(i: { assigneeSlackId: string | null; assigneeName: string; actorName: string; subject: string; status: string; url: string }): string {
  const verb = i.status === 'CLOSED' ? 'closed' : 'resolved';
  return `:white_check_mark: ${mention(i.assigneeSlackId, esc(i.assigneeName))} — *${esc(i.actorName)}* marked <${i.url}|${esc(i.subject || '(no subject)')}> as *${verb}*.`;
}

// ── senders ──────────────────────────────────────────────────────────────

/** Fires after an assignment change; the assignee is never the actor here. */
export async function notifyAssignment(conversationId: string, assigneeId: string, session: AppSession): Promise<NotifyOutcome> {
  const c = await loadConversation(conversationId);
  const assignee = await prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true, name: true, email: true, slackUserId: true } });
  if (!c || !assignee) return { email: 'SKIPPED: not found', slack: 'SKIPPED: not found', inApp: 'SKIPPED' };
  const url = appUrl(`/inbox/${c.id}`);
  const student = c.contact.name || c.recipientEmail;
  const lastLine = lastMessageLine(c);
  const out: NotifyOutcome = { email: '', slack: '', inApp: '' };

  // In-app (§87)
  try {
    await prisma.notification.create({
      data: { workspaceId: c.workspaceId, userId: assignee.id, type: 'ASSIGNMENT', title: `${session.name} assigned you a conversation`, body: c.subject, link: `/inbox/${c.id}` },
    });
    out.inApp = 'SENT';
  } catch (err) {
    out.inApp = `FAILED: ${describeError(err)}`;
  }

  // Email — from the assigner's mailbox, else the conversation's mailbox.
  try {
    const actorBox = session.homeWorkspaceId ? await mailboxFor(session.homeWorkspaceId, session.userId) : null;
    const convBox = await prisma.emailProviderAccount.findUnique({ where: { id: c.emailProviderAccountId } });
    const box = actorBox?.status === 'CONNECTED' ? actorBox : convBox?.status === 'CONNECTED' ? convBox : null;
    if (!box) {
      out.email = 'SKIPPED: no connected Gmail for the assigner or this conversation';
    } else {
      const html = assignmentEmailHtml({ assigneeName: assignee.name, assignerName: session.name, subject: c.subject, student, lastLine, url });
      const result = await new GmailProvider(box).sendEmail({
        to: assignee.email,
        cc: session.email !== assignee.email && session.email !== box.emailAddress ? [session.email] : [],
        fromName: box.displayName ?? session.name,
        fromEmail: box.emailAddress,
        subject: assignmentSubject(c.subject),
        html,
        plainText: htmlToPlainText(html),
      });
      await prisma.conversation.update({
        where: { id: c.id },
        data: { notifyEmailAccountId: box.id, notifyEmailMessageId: result.messageIdHeader, notifyEmailThreadId: result.threadId },
      });
      out.email = `SENT to ${assignee.email} from ${box.emailAddress}`;
    }
  } catch (err) {
    out.email = `FAILED: ${describeError(err)}`;
  }

  // Slack — channel message mentioning the assignee; becomes the thread root.
  try {
    const settings = await integration(c.organizationId);
    const slack = SlackClient.fromEnv();
    if (!slack) out.slack = 'SKIPPED: SLACK_BOT_TOKEN not set';
    else if (!settings?.slackChannelId) out.slack = 'SKIPPED: no Slack channel configured';
    else if (!settings.slackNotifyAssignments) out.slack = 'SKIPPED: assignment notifications are off';
    else {
      const text = assignmentSlackText({ assigneeSlackId: assignee.slackUserId, assigneeName: assignee.name, assignerName: session.name, subject: c.subject, student, lastLine, url });
      const r = await slack.postMessage({ channel: settings.slackChannelId, text });
      if (r.ok && r.data) {
        await prisma.conversation.update({ where: { id: c.id }, data: { notifySlackChannelId: r.data.channel, notifySlackThreadTs: r.data.ts } });
        out.slack = `SENT to ${settings.slackChannelId}${assignee.slackUserId ? '' : ' (assignee has no Slack id — named, not mentioned)'}`;
      } else out.slack = `FAILED: ${r.error}`;
    }
  } catch (err) {
    out.slack = `FAILED: ${describeError(err)}`;
  }

  await audit(session, 'CONVERSATION_NOTIFY', { targetType: 'Conversation', targetId: c.id, metadata: { kind: 'assignment', assigneeId, ...out } });
  return out;
}

/** Fires when status becomes RESOLVED / CLOSED; continues the assignment threads. */
export async function notifyResolution(conversationId: string, status: string, session: AppSession): Promise<NotifyOutcome> {
  const c = await loadConversation(conversationId);
  if (!c) return { email: 'SKIPPED: not found', slack: 'SKIPPED: not found', inApp: 'SKIPPED' };
  const assignee = c.assigneeId ? await prisma.user.findUnique({ where: { id: c.assigneeId }, select: { id: true, name: true, email: true, slackUserId: true } }) : null;
  const url = appUrl(`/inbox/${c.id}`);
  const out: NotifyOutcome = { email: '', slack: '', inApp: '' };

  // In-app for the assignee when someone else resolved it.
  try {
    if (assignee && assignee.id !== session.userId) {
      await prisma.notification.create({
        data: { workspaceId: c.workspaceId, userId: assignee.id, type: 'RESOLVED', title: `${session.name} marked a conversation ${status === 'CLOSED' ? 'closed' : 'resolved'}`, body: c.subject, link: `/inbox/${c.id}` },
      });
      out.inApp = 'SENT';
    } else out.inApp = 'SKIPPED: no other assignee';
  } catch (err) {
    out.inApp = `FAILED: ${describeError(err)}`;
  }

  // Email — reply in the assignment thread when there is one.
  try {
    if (!assignee) out.email = 'SKIPPED: no assignee';
    else {
      const threadBox = c.notifyEmailAccountId ? await prisma.emailProviderAccount.findUnique({ where: { id: c.notifyEmailAccountId } }) : null;
      const actorBox = session.homeWorkspaceId ? await mailboxFor(session.homeWorkspaceId, session.userId) : null;
      const convBox = await prisma.emailProviderAccount.findUnique({ where: { id: c.emailProviderAccountId } });
      const box = threadBox?.status === 'CONNECTED' ? threadBox : actorBox?.status === 'CONNECTED' ? actorBox : convBox?.status === 'CONNECTED' ? convBox : null;
      if (!box) out.email = 'SKIPPED: no connected Gmail';
      else {
        const html = resolutionEmailHtml({ assigneeName: assignee.name, actorName: session.name, subject: c.subject, status, url });
        const sameMailbox = box.id === c.notifyEmailAccountId;
        const result = await new GmailProvider(box).sendEmail({
          to: assignee.email,
          cc: session.email !== assignee.email && session.email !== box.emailAddress ? [session.email] : [],
          fromName: box.displayName ?? session.name,
          fromEmail: box.emailAddress,
          subject: c.notifyEmailMessageId ? `Re: ${assignmentSubject(c.subject)}` : `[MailFlow] ${status === 'CLOSED' ? 'Closed' : 'Resolved'}: ${c.subject || '(no subject)'}`,
          html,
          plainText: htmlToPlainText(html),
          threadId: sameMailbox ? c.notifyEmailThreadId : null,
          inReplyTo: c.notifyEmailMessageId,
          references: buildReferences(null, c.notifyEmailMessageId),
        });
        if (!c.notifyEmailMessageId) {
          await prisma.conversation.update({ where: { id: c.id }, data: { notifyEmailAccountId: box.id, notifyEmailMessageId: result.messageIdHeader, notifyEmailThreadId: result.threadId } });
        }
        out.email = `SENT to ${assignee.email}${c.notifyEmailMessageId ? ' (in the assignment thread)' : ' (new thread)'}`;
      }
    }
  } catch (err) {
    out.email = `FAILED: ${describeError(err)}`;
  }

  // Slack — reply in the assignment thread; start one if there is none.
  try {
    const settings = await integration(c.organizationId);
    const slack = SlackClient.fromEnv();
    const channel = c.notifySlackChannelId ?? settings?.slackChannelId ?? null;
    if (!slack) out.slack = 'SKIPPED: SLACK_BOT_TOKEN not set';
    else if (!channel) out.slack = 'SKIPPED: no Slack channel configured';
    else if (!settings?.slackNotifyResolutions) out.slack = 'SKIPPED: resolution notifications are off';
    else {
      const text = resolutionSlackText({ assigneeSlackId: assignee?.slackUserId ?? null, assigneeName: assignee?.name ?? 'team', actorName: session.name, subject: c.subject, status, url });
      const r = await slack.postMessage({ channel, text, threadTs: c.notifySlackThreadTs, broadcast: false });
      if (r.ok && r.data) {
        if (c.notifySlackThreadTs) await slack.addReaction(channel, c.notifySlackThreadTs, 'white_check_mark');
        else await prisma.conversation.update({ where: { id: c.id }, data: { notifySlackChannelId: r.data.channel, notifySlackThreadTs: r.data.ts } });
        out.slack = `SENT${c.notifySlackThreadTs ? ' (in the assignment thread)' : ' (new message)'}`;
      } else out.slack = `FAILED: ${r.error}`;
    }
  } catch (err) {
    out.slack = `FAILED: ${describeError(err)}`;
  }

  await audit(session, 'CONVERSATION_NOTIFY', { targetType: 'Conversation', targetId: c.id, metadata: { kind: 'resolution', status, ...out } });
  return out;
}
