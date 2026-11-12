import { prisma } from '@/lib/db/client';
import { recordHardBounce } from '@/lib/email/bounces';
import {
  bounceSkipReason,
  CATEGORY_REMARK,
  SOFT_REPEAT_WINDOW_DAYS,
  suppressionReason,
  suppressionRule,
  type BounceCategory,
  type DeliveryFailure,
  type DeliveryReport,
} from '@/lib/email/dsn';

/**
 * Acting on a delivery report (lib/email/dsn.ts): which of our sends it is about, and what to do
 * with each failed address. Used by inbound sync (lib/gmail/ingest.ts) and the backfill script
 * (scripts/backfill-ndr.ts), which prints the plan before anything is written.
 *
 * Matching a notice to a send, most certain first:
 *   1. the Message-ID it answers (In-Reply-To / References, or the original's Message-ID embedded
 *      in the report) → an EmailJob from this mailbox, or a Recruiter Bulk Send group anywhere in
 *      the organization; for a BCC group the failed address is looked up inside that group;
 *   2. the Gmail thread a Recruiter Bulk Send started in this mailbox;
 *   3. the failed address + our sends from THIS mailbox in the 14 days before the notice
 *      (Office 365 NDRs usually carry no In-Reply-To).
 * A notice that matches none of these (and isn't in a known conversation) is about mail MailFlow
 * didn't send, and is left alone.
 *
 * Rules: hard categories, policy and spam blocks, left-the-company and complaints suppress at
 * once (org-wide, lib/email/bounces.ts recordHardBounce); a full mailbox is noted and suppresses
 * on its second notice within 30 days; a temporary delay is only noted; a message that was too
 * large marks the send bounced without suppressing the address.
 */

export const MATCH_WINDOW_DAYS = 14;

export type SendMatch =
  | { kind: 'CAMPAIGN'; workspaceId: string; emailJobId: string; campaignId: string; campaignName: string; email: string; sentAt: Date | null }
  | { kind: 'RECRUITER'; workspaceId: string; blastId: string; blastName: string; mode: string; groupId: string; recipientId: string; email: string; sentAt: Date | null };

export type NdrDecision =
  /** Suppress now (and mark the send bounced). */
  | 'SUPPRESS'
  /** A second full-mailbox notice within the window: suppress. */
  | 'SUPPRESS_REPEAT'
  /** First full-mailbox notice: noted, counted, not suppressed. */
  | 'SOFT_FIRST'
  /** Delay / temporary: noted only. */
  | 'NOTE'
  /** The message itself was the problem (too large): the send shows bounced, the address stays. */
  | 'MARK_ONLY'
  /** Not about anything MailFlow sent. */
  | 'NO_MATCH';

export interface NdrAction {
  email: string | null;
  category: BounceCategory;
  statusCode: string | null;
  remark: string;
  diagnostic: string | null;
  decision: NdrDecision;
  workspaceId: string | null;
  organizationId: string;
  send: SendMatch | null;
  /** Human summary of where it came from ("Recruiter Bulk Send “X”"). */
  sourceLabel: string;
}

export interface NdrContext {
  account: { id: string; emailAddress: string; workspaceId: string; organizationId: string };
  report: DeliveryReport;
  gmailMessageId: string;
  gmailThreadId: string | null;
  /** When the notice arrived (matching window and soft-bounce dating). */
  receivedAt: Date;
  /** The MailFlow conversation the notice sits in, if any (its recipient is the fallback address). */
  conversation?: { workspaceId: string; recipientEmail: string | null } | null;
}

const DAY = 86_400_000;

export function willSuppress(decision: NdrDecision): boolean {
  return decision === 'SUPPRESS' || decision === 'SUPPRESS_REPEAT';
}

function sourceLabel(send: SendMatch | null, kind: DeliveryReport['kind']): string {
  const what = kind === 'COMPLAINT' ? 'Spam complaint' : kind === 'LEFT_COMPANY' ? 'Automatic reply' : 'Bounce notice';
  if (!send) return what;
  return send.kind === 'RECRUITER' ? `${what} (Recruiter Bulk Send “${send.blastName}”)` : `${what} (“${send.campaignName}”)`;
}

/** Finds the sends a report is about. Read-only. */
export async function matchSends(ctx: NdrContext): Promise<{ byEmail: Map<string, SendMatch>; byMessage: SendMatch[] }> {
  const { account, report } = ctx;
  const ids = report.referencedIds;
  const byEmail = new Map<string, SendMatch>();
  const byMessage: SendMatch[] = [];
  const emails = [...new Set(report.failures.map((f) => f.email).filter((e): e is string => !!e))];

  // 1 + 2: by Message-ID / thread.
  const [jobs, groups] = await Promise.all([
    ids.length
      ? prisma.emailJob.findMany({
          where: { messageIdHeader: { in: ids }, emailProviderAccountId: account.id },
          select: { id: true, toEmail: true, campaignId: true, sentAt: true, campaign: { select: { name: true, workspaceId: true } } },
        })
      : Promise.resolve([]),
    ids.length || ctx.gmailThreadId
      ? prisma.recruiterBlastGroup.findMany({
          where: {
            status: 'SENT',
            OR: [
              ...(ids.length ? [{ messageIdHeader: { in: ids }, blast: { organizationId: account.organizationId } }] : []),
              ...(ctx.gmailThreadId ? [{ gmailThreadId: ctx.gmailThreadId, accountId: account.id }] : []),
            ],
          },
          select: { id: true, sentAt: true, blast: { select: { id: true, name: true, workspaceId: true, mode: true } } },
        })
      : Promise.resolve([]),
  ]);

  for (const j of jobs) {
    const m: SendMatch = { kind: 'CAMPAIGN', workspaceId: j.campaign.workspaceId, emailJobId: j.id, campaignId: j.campaignId, campaignName: j.campaign.name, email: j.toEmail.toLowerCase(), sentAt: j.sentAt };
    byMessage.push(m);
    if (emails.includes(m.email) || !emails.length) byEmail.set(m.email, m);
  }

  if (groups.length) {
    const groupIds = groups.map((g) => g.id);
    // A BCC group: the failed address inside that group. An individual copy (one recipient): that
    // recipient, even when the notice names an alias or no address at all.
    const recipients = await prisma.recruiterBlastRecipient.findMany({
      where: { groupId: { in: groupIds }, ...(emails.length ? { OR: [{ email: { in: emails } }, { group: { recipientCount: 1 } }] } : { group: { recipientCount: 1 } }) },
      select: { id: true, email: true, groupId: true },
    });
    for (const r of recipients) {
      const g = groups.find((x) => x.id === r.groupId);
      if (!g) continue;
      const m: SendMatch = { kind: 'RECRUITER', workspaceId: g.blast.workspaceId, blastId: g.blast.id, blastName: g.blast.name, mode: g.blast.mode, groupId: g.id, recipientId: r.id, email: r.email.toLowerCase(), sentAt: g.sentAt };
      byMessage.push(m);
      if (emails.includes(m.email) || !emails.length) byEmail.set(m.email, m);
    }
  }

  // 3: the failed address + our recent sends from this mailbox.
  const missing = emails.filter((e) => !byEmail.has(e));
  if (missing.length) {
    const since = new Date(ctx.receivedAt.getTime() - MATCH_WINDOW_DAYS * DAY);
    const until = new Date(ctx.receivedAt.getTime() + DAY);
    const [recentJobs, recentRecipients] = await Promise.all([
      prisma.emailJob.findMany({
        where: { emailProviderAccountId: account.id, toEmail: { in: missing, mode: 'insensitive' }, sentAt: { gte: since, lte: until } },
        orderBy: { sentAt: 'desc' },
        take: 50,
        select: { id: true, toEmail: true, campaignId: true, sentAt: true, campaign: { select: { name: true, workspaceId: true } } },
      }),
      prisma.recruiterBlastRecipient.findMany({
        where: { email: { in: missing }, group: { accountId: account.id, status: 'SENT', sentAt: { gte: since, lte: until } } },
        take: 50,
        select: { id: true, email: true, groupId: true, group: { select: { sentAt: true } }, blast: { select: { id: true, name: true, workspaceId: true, mode: true } } },
      }),
    ]);
    for (const email of missing) {
      const job = recentJobs.find((j) => j.toEmail.toLowerCase() === email);
      const rec = recentRecipients
        .filter((r) => r.email.toLowerCase() === email && r.groupId)
        .sort((a, b) => (b.group?.sentAt?.getTime() ?? 0) - (a.group?.sentAt?.getTime() ?? 0))[0];
      const jobAt = job?.sentAt?.getTime() ?? -1;
      const recAt = rec?.group?.sentAt?.getTime() ?? -1;
      if (rec && recAt >= jobAt) {
        byEmail.set(email, { kind: 'RECRUITER', workspaceId: rec.blast.workspaceId, blastId: rec.blast.id, blastName: rec.blast.name, mode: rec.blast.mode, groupId: rec.groupId!, recipientId: rec.id, email, sentAt: rec.group?.sentAt ?? null });
      } else if (job) {
        byEmail.set(email, { kind: 'CAMPAIGN', workspaceId: job.campaign.workspaceId, emailJobId: job.id, campaignId: job.campaignId, campaignName: job.campaign.name, email, sentAt: job.sentAt });
      }
    }
  }
  return { byEmail, byMessage };
}

/** What would be done with a report. Read-only (the backfill's dry run prints this). */
export async function planDeliveryReport(ctx: NdrContext): Promise<NdrAction[]> {
  const { report, account } = ctx;
  const { byEmail, byMessage } = await matchSends(ctx);
  const own = ctx.account.emailAddress.toLowerCase();
  const convRecipient = ctx.conversation?.recipientEmail?.toLowerCase() ?? null;
  const usableConv = convRecipient && convRecipient !== own && !/^(mailer-daemon|postmaster|mail-daemon)@/i.test(convRecipient) ? convRecipient : null;
  const actions: NdrAction[] = [];

  for (const f of report.failures) {
    // Which address: the one the notice names, else the only send it answers, else the conversation's.
    let email = f.email;
    let send: SendMatch | null = email ? (byEmail.get(email) ?? null) : null;
    if (!email) {
      const single = byMessage.length === 1 ? byMessage[0]! : null;
      send = single;
      email = single?.email ?? usableConv;
    }
    if (actions.some((a) => a.email === email && email)) continue;
    const workspaceId = send?.workspaceId ?? ctx.conversation?.workspaceId ?? null;
    const inConversation = !!ctx.conversation && !!email;
    let decision: NdrDecision;
    if (!email || (!send && !inConversation)) decision = 'NO_MATCH';
    else decision = await decide(f, email, ctx);
    actions.push({
      email,
      category: f.category,
      statusCode: f.statusCode,
      remark: f.remark || CATEGORY_REMARK[f.category],
      diagnostic: f.diagnostic,
      decision,
      workspaceId: decision === 'NO_MATCH' ? workspaceId : (workspaceId ?? account.workspaceId),
      organizationId: account.organizationId,
      send,
      sourceLabel: sourceLabel(send, report.kind),
    });
  }
  return actions;
}

async function decide(f: DeliveryFailure, email: string, ctx: NdrContext): Promise<NdrDecision> {
  const rule = suppressionRule(f.category);
  if (rule === 'NOW') return 'SUPPRESS';
  if (f.category === 'MESSAGE_TOO_LARGE') return 'MARK_ONLY';
  if (rule === 'NEVER') return 'NOTE';
  // ON_REPEAT (full mailbox): another notice for this address within the window?
  const windowMs = SOFT_REPEAT_WINDOW_DAYS * DAY;
  const earlier = await prisma.softBounce.count({
    where: {
      organizationId: ctx.account.organizationId,
      email,
      category: f.category,
      occurredAt: { gte: new Date(ctx.receivedAt.getTime() - windowMs), lte: new Date(ctx.receivedAt.getTime() + windowMs) },
      NOT: { gmailMessageId: ctx.gmailMessageId },
    },
  });
  return earlier > 0 ? 'SUPPRESS_REPEAT' : 'SOFT_FIRST';
}

/** Plans and carries out a report. Throws when a write fails (the caller retries the notice). */
export async function applyDeliveryReport(ctx: NdrContext): Promise<NdrAction[]> {
  const actions = await planDeliveryReport(ctx);
  for (const a of actions) await applyAction(a, ctx);
  return actions;
}

export async function applyAction(a: NdrAction, ctx: Pick<NdrContext, 'gmailMessageId' | 'receivedAt'>): Promise<void> {
  if (a.decision === 'NO_MATCH' || !a.email || !a.workspaceId) return;
  const email = a.email;
  const campaignId = a.send?.kind === 'CAMPAIGN' ? a.send.campaignId : null;
  const recruiterBlastId = a.send?.kind === 'RECRUITER' ? a.send.blastId : null;

  // Soft notices are kept (counted for the full-mailbox rule; shown nowhere else yet).
  if (a.decision === 'SOFT_FIRST' || a.decision === 'SUPPRESS_REPEAT' || a.decision === 'NOTE' || a.decision === 'MARK_ONLY') {
    await prisma.softBounce.createMany({
      data: [{ organizationId: a.organizationId, workspaceId: a.workspaceId, email, category: a.category, statusCode: a.statusCode, detail: a.diagnostic?.slice(0, 1000) ?? null, gmailMessageId: ctx.gmailMessageId, campaignId, recruiterBlastId, occurredAt: ctx.receivedAt }],
      skipDuplicates: true,
    });
  }

  if (willSuppress(a.decision)) {
    const words = a.diagnostic ?? a.remark;
    await recordHardBounce({
      workspaceId: a.workspaceId,
      email,
      detail: words,
      campaignId,
      recruiterBlastId,
      category: a.category,
      statusCode: a.statusCode,
      remark: `${a.decision === 'SUPPRESS_REPEAT' ? `${a.remark} (second notice in ${SOFT_REPEAT_WINDOW_DAYS} days)` : a.remark} · ${a.sourceLabel}`,
      reason: suppressionReason(a.category),
    });
  }

  // The send shows what happened: bounced (with the reason) for anything that stops delivery.
  if (willSuppress(a.decision) || a.decision === 'MARK_ONLY') {
    const reason = bounceSkipReason(a);
    if (a.send?.kind === 'RECRUITER') {
      await prisma.recruiterBlastRecipient.updateMany({ where: { id: a.send.recipientId }, data: { status: 'BOUNCED', skipReason: reason } });
    } else if (a.send?.kind === 'CAMPAIGN') {
      // EmailJob.status stays SENT (it went out, and daily-limit counts rely on it); the bounce shows as its error.
      await prisma.emailJob.updateMany({ where: { id: a.send.emailJobId }, data: { errorCode: 'BOUNCED', errorMessage: `${reason}${a.diagnostic ? ` — ${a.diagnostic}` : ''}`.slice(0, 1000) } });
    }
  }
}

/** One line per action, for logs and the backfill report. */
export function describeAction(a: NdrAction): string {
  const send = a.send ? (a.send.kind === 'RECRUITER' ? `recruiter send “${a.send.blastName}” (${a.send.mode})` : `campaign “${a.send.campaignName}”`) : 'no matching send';
  return `${a.email ?? '(no address)'} · ${a.category}${a.statusCode ? ` ${a.statusCode}` : ''} · ${a.remark} · ${send} · ${a.decision}${willSuppress(a.decision) ? ' → suppress' : ''}${a.diagnostic ? ` · “${a.diagnostic.slice(0, 160)}”` : ''}`;
}
