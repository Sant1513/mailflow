import { prisma } from '@/lib/db/client';
import { GmailProvider } from '@/lib/email/gmail';
import { buildReferences } from '@/lib/email/mime';
import { SendEmailError } from '@/lib/email/provider';
import { escapeHtml, htmlToPlainText } from '@/lib/templates/variables';
import { audit } from '@/lib/audit/log';
import type { AppSession } from '@/lib/auth/session';
import { EmailProvider as EmailProviderEnum, Role, UserStatus } from '@prisma/client';

/**
 * §36 approval notifications, all in ONE Gmail thread:
 *
 *   submit  → "Approval requested: <campaign>"  from the requester's mailbox
 *             To: every SUPER_ADMIN + the workspace's ADMINs, Cc: requester
 *   decide  → "Re: Approval requested: …"        reply in that thread
 *             To: requester (Cc: reviewer), from the reviewer's mailbox when
 *             connected, else the requester's own mailbox — so the thread is
 *             always continued (In-Reply-To / References; same threadId when
 *             the same mailbox sends both).
 *
 * Email is best effort: a decision or a submission never fails because a
 * mailbox is missing or Gmail is down. The outcome is recorded on the
 * campaign (approvalRequestEmail / approvalDecisionEmail) and shown in the UI.
 */

export type Decision = 'APPROVED' | 'REJECTED';

export function appUrl(path: string): string {
  const base = (process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return `${base}${path}`;
}

export function approvalRequestSubject(campaignName: string): string {
  return `[MailFlow] Approval requested: ${campaignName}`;
}

export interface RequestEmailInput {
  campaignName: string;
  requesterName: string;
  requesterEmail: string;
  workspaceName: string;
  datasetName: string;
  recipientCount: number;
  subjectLine: string;
  templateName: string;
  templateVersion: number;
  reviewUrl: string;
}

function shell(title: string, body: string): string {
  return [
    `<div style="font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;color:#2d3748;line-height:1.5;max-width:640px">`,
    `<h2 style="margin:0 0 12px;color:#111">${escapeHtml(title)}</h2>`,
    body,
    `<p style="margin-top:24px;font-size:12px;color:#718096">Sent by MailFlow · Masai School internal tool</p>`,
    `</div>`,
  ].join('\n');
}

export function renderApprovalRequest(i: RequestEmailInput): { html: string; plainText: string } {
  const rows: [string, string][] = [
    ['Campaign', i.campaignName],
    ['Requested by', `${i.requesterName} <${i.requesterEmail}>`],
    ['Workspace', i.workspaceName],
    ['Dataset', i.datasetName],
    ['Recipients', String(i.recipientCount)],
    ['Email subject', i.subjectLine],
    ['Template', `${i.templateName} (v${i.templateVersion})`],
  ];
  const table = `<table style="border-collapse:collapse;margin:12px 0">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#718096">${escapeHtml(k)}</td><td style="padding:4px 0"><strong>${escapeHtml(v)}</strong></td></tr>`)
    .join('')}</table>`;
  const html = shell(
    'A campaign is waiting for your approval',
    `<p>${escapeHtml(i.requesterName)} has submitted a campaign for review. Nothing is sent until an admin approves it.</p>${table}<p><a href="${escapeHtml(i.reviewUrl)}" style="display:inline-block;background:#ED0331;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Review and approve</a></p><p style="color:#718096;font-size:13px">Or open MailFlow → Approvals.</p>`
  );
  return { html, plainText: htmlToPlainText(html) };
}

export interface DecisionEmailInput {
  campaignName: string;
  decision: Decision;
  reviewerName: string;
  reason?: string | null;
  reviewUrl: string;
}

export function renderApprovalDecision(i: DecisionEmailInput): { html: string; plainText: string } {
  const approved = i.decision === 'APPROVED';
  const body = approved
    ? `<p>Your campaign <strong>${escapeHtml(i.campaignName)}</strong> was <strong style="color:#059669">approved</strong> by ${escapeHtml(i.reviewerName)}. You can now send it from the campaign page.</p>`
    : `<p>Your campaign <strong>${escapeHtml(i.campaignName)}</strong> was <strong style="color:#ED0331">rejected</strong> by ${escapeHtml(i.reviewerName)}.</p>${
        i.reason ? `<p style="border-left:3px solid #ED0331;padding:8px 12px;background:#fff5f6"><strong>Reason:</strong> ${escapeHtml(i.reason)}</p>` : ''
      }<p>Update the campaign and submit it again when ready.</p>`;
  const html = shell(approved ? 'Campaign approved' : 'Campaign rejected', `${body}<p><a href="${escapeHtml(i.reviewUrl)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Open campaign</a></p>`);
  return { html, plainText: htmlToPlainText(html) };
}

export interface MailboxLike {
  id: string;
  status: string;
  emailAddress: string;
}

/**
 * Which mailbox continues the thread for the decision. The reviewer's own
 * connected mailbox is preferred (the reply genuinely comes from them);
 * otherwise the requester's, which is guaranteed to hold the original
 * thread. `sameThread` says whether Gmail's threadId can be reused.
 */
export function pickDecisionMailbox<T extends MailboxLike>(opts: {
  reviewer: T | null;
  requester: T | null;
  requestAccountId: string | null;
}): { account: T; sameThread: boolean } | null {
  const connected = (a: T | null): a is T => !!a && a.status === 'CONNECTED';
  const pick = connected(opts.reviewer) ? opts.reviewer : connected(opts.requester) ? opts.requester : null;
  if (!pick) return null;
  return { account: pick, sameThread: pick.id === opts.requestAccountId };
}

async function mailboxFor(workspaceId: string, userId: string) {
  return prisma.emailProviderAccount.findUnique({
    where: { workspaceId_userId_provider: { workspaceId, userId, provider: EmailProviderEnum.GMAIL } },
  });
}

/** Approvers for a campaign: active SUPER_ADMINs org-wide plus ADMINs attached to the workspace, minus the requester. */
export async function approverEmails(organizationId: string, workspaceId: string, excludeUserId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      organizationId,
      status: UserStatus.ACTIVE,
      id: { not: excludeUserId },
      OR: [
        { role: Role.SUPER_ADMIN },
        { role: Role.ADMIN, OR: [{ ownedWorkspaces: { some: { id: workspaceId } } }, { workspaceMemberships: { some: { workspaceId } } }] },
      ],
    },
    select: { email: true },
  });
  return Array.from(new Set(users.map((u) => u.email.toLowerCase())));
}

function describeError(err: unknown): string {
  if (err instanceof SendEmailError) return `${err.kind}: ${err.message}`.slice(0, 300);
  return ((err as Error)?.message ?? 'unknown error').slice(0, 300);
}

/** Sends the request email; returns the status string stored on the campaign. Never throws. */
export async function sendApprovalRequestEmail(campaignId: string, session: AppSession): Promise<string> {
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      workspace: { select: { name: true } },
      dataset: { select: { name: true } },
      template: { select: { name: true } },
      templateVersion: { select: { version: true, subject: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      _count: { select: { campaignRecords: true } },
    },
  });
  if (!c) return 'FAILED: campaign not found';

  let status: string;
  try {
    const mailbox = await mailboxFor(c.workspaceId, c.createdById);
    if (!mailbox || mailbox.status !== 'CONNECTED') {
      status = 'SKIPPED: requester has no connected Gmail';
    } else {
      const to = await approverEmails(c.organizationId, c.workspaceId, c.createdById);
      if (to.length === 0) {
        status = 'SKIPPED: no admin to notify';
      } else {
        const { html, plainText } = renderApprovalRequest({
          campaignName: c.name,
          requesterName: c.createdBy.name,
          requesterEmail: c.createdBy.email,
          workspaceName: c.workspace.name,
          datasetName: c.dataset.name,
          recipientCount: c._count.campaignRecords,
          subjectLine: c.templateVersion.subject,
          templateName: c.template.name,
          templateVersion: c.templateVersion.version,
          reviewUrl: appUrl(`/campaigns/${c.id}`),
        });
        const result = await new GmailProvider(mailbox).sendEmail({
          to: to[0]!,
          cc: [...to.slice(1), c.createdBy.email],
          fromName: mailbox.displayName ?? c.createdBy.name,
          fromEmail: mailbox.emailAddress,
          subject: approvalRequestSubject(c.name),
          html,
          plainText,
        });
        await prisma.campaign.update({
          where: { id: c.id },
          data: {
            approvalRequestAccountId: mailbox.id,
            approvalRequestMessageId: result.messageIdHeader,
            approvalRequestThreadId: result.threadId,
          },
        });
        status = `SENT to ${to.length} approver(s)`;
      }
    }
  } catch (err) {
    status = `FAILED: ${describeError(err)}`;
  }

  await prisma.campaign.update({ where: { id: c.id }, data: { approvalRequestEmail: status } });
  await audit(session, 'CAMPAIGN_APPROVAL_EMAIL', { targetType: 'Campaign', targetId: c.id, metadata: { kind: 'request', status } });
  return status;
}

/** Sends the decision in the request's thread; returns the status stored on the campaign. Never throws. */
export async function sendApprovalDecisionEmail(campaignId: string, decision: Decision, session: AppSession, reason?: string | null): Promise<string> {
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  });
  if (!c) return 'FAILED: campaign not found';

  let status: string;
  try {
    const [reviewerBox, requesterBox] = await Promise.all([
      session.homeWorkspaceId ? mailboxFor(session.homeWorkspaceId, session.userId) : null,
      mailboxFor(c.workspaceId, c.createdById),
    ]);
    const picked = pickDecisionMailbox({ reviewer: reviewerBox, requester: requesterBox, requestAccountId: c.approvalRequestAccountId });
    if (!picked) {
      status = 'SKIPPED: no connected Gmail for reviewer or requester';
    } else {
      const { html, plainText } = renderApprovalDecision({
        campaignName: c.name,
        decision,
        reviewerName: session.name,
        reason,
        reviewUrl: appUrl(`/campaigns/${c.id}`),
      });
      const inReplyTo = c.approvalRequestMessageId;
      const references = buildReferences(null, c.approvalRequestMessageId);
      const cc = picked.account.id !== reviewerBox?.id && reviewerBox ? [reviewerBox.emailAddress] : session.email !== c.createdBy.email ? [session.email] : [];
      const result = await new GmailProvider(picked.account).sendEmail({
        to: c.createdBy.email,
        cc,
        fromName: picked.account.displayName ?? session.name,
        fromEmail: picked.account.emailAddress,
        subject: `Re: ${approvalRequestSubject(c.name)}`,
        html,
        plainText,
        threadId: picked.sameThread ? c.approvalRequestThreadId : null,
        inReplyTo,
        references,
      });
      status = `SENT from ${picked.account.emailAddress}${inReplyTo ? ' (in thread)' : ' (new thread — no request message id)'}${result.threadId ? '' : ''}`;
    }
  } catch (err) {
    status = `FAILED: ${describeError(err)}`;
  }

  await prisma.campaign.update({ where: { id: c.id }, data: { approvalDecisionEmail: status } });
  await audit(session, 'CAMPAIGN_APPROVAL_EMAIL', { targetType: 'Campaign', targetId: c.id, metadata: { kind: 'decision', decision, status } });
  return status;
}
