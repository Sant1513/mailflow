import { CampaignStatus, ConversationStatus, MessageClassification, MessageDirection, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { checkSlaBreach } from '@/lib/sla';
import { appBaseUrl } from '@/lib/app-url';
import { escapeHtml } from '@/lib/templates/variables';
import { sectionHtml, systemEmailShell } from '@/lib/notify/system';

/**
 * The daily "needs attention" digest: everything in an organisation that is
 * waiting on a person today. Pure data first (collectNeedsAttention), then
 * rendering (renderDigestEmail / renderDigestSlack), so the content can be
 * previewed and tested without sending anything.
 */

export interface DigestItem {
  title: string;
  detail: string;
  workspace: string;
  href: string;
}

export interface NeedsAttention {
  generatedAt: Date;
  expiringDocuments: DigestItem[];
  slaBreaches: DigestItem[];
  pendingCampaigns: DigestItem[];
  pendingUsers: DigestItem[];
  unansweredReplies: DigestItem[];
}

export const digestTotal = (d: NeedsAttention) =>
  d.expiringDocuments.length + d.slaBreaches.length + d.pendingCampaigns.length + d.pendingUsers.length + d.unansweredReplies.length;

const OPEN: ConversationStatus[] = [ConversationStatus.OPEN, ConversationStatus.IN_PROGRESS];

function ago(from: Date, now: Date): string {
  const hours = Math.max(0, Math.round((now.getTime() - from.getTime()) / 3_600_000));
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

function until(to: Date, now: Date): string {
  const hours = Math.max(0, Math.round((to.getTime() - now.getTime()) / 3_600_000));
  return hours < 1 ? 'within the hour' : hours < 48 ? `in ${hours} hour${hours === 1 ? '' : 's'}` : `in ${Math.round(hours / 24)} days`;
}

export async function collectNeedsAttention(
  organizationId: string,
  opts: { expiringWithinHours: number; unansweredAfterHours: number },
  now: Date = new Date(),
): Promise<NeedsAttention> {
  const expiryCutoff = new Date(now.getTime() + opts.expiringWithinHours * 3_600_000);
  const unansweredCutoff = new Date(now.getTime() - opts.unansweredAfterHours * 3_600_000);

  const [expiring, pendingCampaigns, pendingUsers, openConversations, slaRules] = await Promise.all([
    prisma.signingRequest.findMany({
      where: {
        workspace: { organizationId },
        status: { in: ['SENT', 'VIEWED'] },
        expiresAt: { gt: now, lte: expiryCutoff },
      },
      orderBy: { expiresAt: 'asc' },
      take: 200,
      select: { title: true, recipientName: true, recipientEmail: true, status: true, expiresAt: true, workspace: { select: { name: true } } },
    }),
    prisma.campaign.findMany({
      where: { organizationId, status: CampaignStatus.PENDING_APPROVAL },
      orderBy: { submittedAt: 'asc' },
      take: 200,
      select: { id: true, name: true, submittedAt: true, updatedAt: true, workspace: { select: { name: true } } },
    }),
    prisma.user.findMany({
      where: { organizationId, status: UserStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { name: true, email: true, createdAt: true },
    }),
    prisma.conversation.findMany({
      where: { organizationId, status: { in: OPEN } },
      orderBy: { lastMessageAt: 'asc' },
      take: 1000,
      select: {
        id: true,
        subject: true,
        recipientEmail: true,
        status: true,
        firstMessageAt: true,
        lastMessageAt: true,
        assigneeId: true,
        workspaceId: true,
        workspace: { select: { name: true } },
        assignee: { select: { name: true } },
        contact: { select: { name: true } },
        tags: { include: { tag: { select: { name: true } } } },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { direction: true, classification: true, sentAt: true, receivedAt: true },
        },
      },
    }),
    prisma.slaRule.findMany({
      where: { active: true, workspace: { organizationId } },
      select: { workspaceId: true, firstResponseMinutes: true, appliesTo: true, tagName: true, assigneeId: true },
    }),
  ]);

  const base = appBaseUrl();
  const who = (c: (typeof openConversations)[number]) => c.contact?.name || c.recipientEmail;
  const owner = (c: (typeof openConversations)[number]) => (c.assignee?.name ? `assigned to ${c.assignee.name}` : 'unassigned');

  const rulesByWorkspace = new Map<string, typeof slaRules>();
  for (const r of slaRules) rulesByWorkspace.set(r.workspaceId, [...(rulesByWorkspace.get(r.workspaceId) ?? []), r]);

  const slaBreaches: DigestItem[] = [];
  const unansweredReplies: DigestItem[] = [];
  for (const c of openConversations) {
    const rules = rulesByWorkspace.get(c.workspaceId) ?? [];
    if (rules.length) {
      const sla = checkSlaBreach(c, rules, now);
      if (sla.slaBreached) {
        slaBreaches.push({
          title: `${who(c)}: ${c.subject ?? '(no subject)'}`,
          detail: `${Math.round(sla.slaMinutesOverdue / 60)}h past the response target, ${owner(c)}`,
          workspace: c.workspace.name,
          href: `${base}/inbox/${c.id}`,
        });
      }
    }
    const last = c.messages[0];
    const lastAt = last?.receivedAt ?? last?.sentAt ?? null;
    if (
      last &&
      last.direction === MessageDirection.INBOUND &&
      last.classification === MessageClassification.HUMAN_REPLY &&
      lastAt &&
      lastAt <= unansweredCutoff
    ) {
      unansweredReplies.push({
        title: `${who(c)}: ${c.subject ?? '(no subject)'}`,
        detail: `replied ${ago(lastAt, now)} ago, no answer yet, ${owner(c)}`,
        workspace: c.workspace.name,
        href: `${base}/inbox/${c.id}`,
      });
    }
  }

  return {
    generatedAt: now,
    expiringDocuments: expiring.map((r) => ({
      title: `${r.title}: ${r.recipientName} <${r.recipientEmail}>`,
      detail: `${r.status === 'VIEWED' ? 'opened but not signed' : 'not opened yet'}, expires ${until(r.expiresAt!, now)}`,
      workspace: r.workspace.name,
      href: `${base}/documents?status=${r.status}`,
    })),
    slaBreaches,
    pendingCampaigns: pendingCampaigns.map((c) => ({
      title: c.name,
      detail: `waiting ${ago(c.submittedAt ?? c.updatedAt, now)} for approval`,
      workspace: c.workspace.name,
      href: `${base}/approvals`,
    })),
    pendingUsers: pendingUsers.map((u) => ({
      title: `${u.name ?? u.email} <${u.email}>`,
      detail: `signed up ${ago(u.createdAt, now)} ago`,
      workspace: '',
      href: `${base}/approvals?section=users`,
    })),
    unansweredReplies,
  };
}

const ROW_LIMIT = 15;

function rowsHtml(items: DigestItem[]): string[] {
  return items.slice(0, ROW_LIMIT).map(
    (i) =>
      `<a href="${escapeHtml(i.href)}" style="color:#111;text-decoration:none"><strong>${escapeHtml(i.title)}</strong></a> <span style="color:#718096">· ${escapeHtml(i.detail)}${i.workspace ? ` · ${escapeHtml(i.workspace)}` : ''}</span>`,
  );
}

export function renderDigestEmail(d: NeedsAttention): { subject: string; html: string } {
  const total = digestTotal(d);
  const base = appBaseUrl();
  const day = d.generatedAt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
  const body = [
    sectionHtml('Replies waiting for an answer', d.unansweredReplies.length, rowsHtml(d.unansweredReplies), 'Every student reply has been answered.', { href: `${base}/inbox`, label: 'Open the inbox' }),
    sectionHtml('Conversations past their SLA', d.slaBreaches.length, rowsHtml(d.slaBreaches), 'Nothing is past its response target.', { href: `${base}/inbox`, label: 'Open the inbox' }),
    sectionHtml('Documents expiring unsigned', d.expiringDocuments.length, rowsHtml(d.expiringDocuments), 'No unsigned documents are about to expire.', { href: `${base}/documents`, label: 'Open Documents' }),
    sectionHtml('Campaigns waiting for approval', d.pendingCampaigns.length, rowsHtml(d.pendingCampaigns), 'No campaigns are waiting for approval.', { href: `${base}/approvals`, label: 'Open Approvals' }),
    sectionHtml('New users waiting for approval', d.pendingUsers.length, rowsHtml(d.pendingUsers), 'No sign-ups are waiting.', { href: `${base}/approvals?section=users`, label: 'Open Approvals' }),
  ].join('\n');
  return {
    subject: total ? `[MailFlow] ${total} thing${total === 1 ? '' : 's'} need attention today` : '[MailFlow] All clear today',
    html: systemEmailShell('What needs attention today', day, body),
  };
}

export function renderDigestSlack(d: NeedsAttention): string {
  const base = appBaseUrl();
  const line = (label: string, items: DigestItem[], href: string) =>
    items.length ? `• *${items.length}* ${label} — <${href}|open>` : null;
  const lines = [
    line('replies waiting for an answer', d.unansweredReplies, `${base}/inbox`),
    line('conversations past their SLA', d.slaBreaches, `${base}/inbox`),
    line('documents expiring unsigned', d.expiringDocuments, `${base}/documents`),
    line('campaigns waiting for approval', d.pendingCampaigns, `${base}/approvals`),
    line('new users waiting for approval', d.pendingUsers, `${base}/approvals?section=users`),
  ].filter(Boolean);
  return lines.length
    ? `:bell: *MailFlow — what needs attention today*\n${lines.join('\n')}`
    : ':white_check_mark: *MailFlow* — nothing needs attention today.';
}
