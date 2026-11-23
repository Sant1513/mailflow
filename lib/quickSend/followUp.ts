import { prisma } from '@/lib/db/client';
import { suppressedKeys } from '@/lib/email/suppressedKeys';
import { emailKey } from '@/lib/recruiterSend/emailKey';
import { EmailJobStatus } from '@prisma/client';
import { fallbackOptIns } from '@/lib/campaigns/fallback';
import { type FollowUpSegment, type OnMailboxDown } from '@/lib/recruiterSend/followUp';

/**
 * Quick Send follow-up: a second (third…) email to the people of a Quick Send that finished.
 * A follow-up is an ordinary Quick Send campaign (same compose screen, check, queue, pacing,
 * tracking, approvals) that points at the campaign it follows up:
 *   parentCampaignId  the previous round; rootCampaignId  the first campaign of the chain; round  2, 3…
 * Each person's email is queued as a reply in the Gmail thread of the email they last received
 * (EmailJob.replyThreadId + inReplyToJobId), from the same mailbox, because Gmail only threads
 * inside one mailbox. When that mailbox is unavailable the sender chooses (Campaign.onMailboxDown):
 * WAIT for it, or FALLBACK to a backup mailbox and a new thread.
 *
 * Who it goes to uses the same segments as the Recruiter Follow-up (no reply & opened / not opened,
 * already replied), and anyone on the workspace suppression list is never included.
 */

export interface QsCandidate {
  email: string;
  name: string | null;
  /** The person's columns by label, from the list of the email they last received. */
  data: Record<string, string>;
  /** Their last email (job) in the chain, and where it came from. */
  sourceJobId: string;
  sourceCampaignId: string;
  sourceAccountId: string | null;
  replied: boolean;
  /** Opened the last email (known: Quick Send emails are individual). */
  opened: boolean;
  bounced: boolean;
  suppressed: boolean;
  lastSentAt: Date | null;
}

const chainWhere = (rootId: string) => ({ OR: [{ id: rootId }, { rootCampaignId: rootId }] });
const lower = (s: string) => s.trim().toLowerCase();

/** Everyone who was sent an email in this chain, with what is known about them across every round. */
export async function chainCandidates(rootCampaignId: string, workspaceId: string): Promise<QsCandidate[]> {
  const jobs = await prisma.emailJob.findMany({
    where: { campaign: chainWhere(rootCampaignId), status: EmailJobStatus.SENT },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, toEmail: true, campaignId: true, emailProviderAccountId: true, sentAt: true, errorCode: true, gmailThreadId: true,
      record: { select: { data: true } },
      campaign: { select: { datasetId: true } },
    },
  });
  if (!jobs.length) return [];

  const datasetIds = [...new Set(jobs.map((j) => j.campaign.datasetId))];
  const datasets = await prisma.dataset.findMany({ where: { id: { in: datasetIds } }, select: { id: true, columns: { select: { key: true, label: true } } } });
  const labelOf = new Map(datasets.map((d) => [d.id, new Map(d.columns.map((c) => [c.key, c.label]))]));

  // The latest SENT email per person; bounced in any round counts.
  const by = new Map<string, QsCandidate>();
  const threadsOf = new Map<string, Set<string>>(); // gmail thread → people in it
  for (const j of jobs) {
    const email = lower(j.toEmail);
    const labels = labelOf.get(j.campaign.datasetId);
    const raw = j.record?.data && typeof j.record.data === 'object' && !Array.isArray(j.record.data) ? (j.record.data as Record<string, unknown>) : {};
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) data[labels?.get(k) ?? k] = v == null ? '' : String(v).trim().slice(0, 2000);
    const prev = by.get(email);
    by.set(email, {
      email,
      name: data.Name || data.name || prev?.name || null,
      data,
      sourceJobId: j.id,
      sourceCampaignId: j.campaignId,
      sourceAccountId: j.emailProviderAccountId,
      replied: prev?.replied ?? false,
      opened: false,
      bounced: (prev?.bounced ?? false) || j.errorCode === 'BOUNCED',
      suppressed: false,
      lastSentAt: j.sentAt,
    });
    if (j.gmailThreadId) threadsOf.set(j.gmailThreadId, (threadsOf.get(j.gmailThreadId) ?? new Set()).add(email));
  }

  // Replies: a real person answered in any thread of the chain.
  const threadIds = [...threadsOf.keys()];
  for (let i = 0; i < threadIds.length; i += 1000) {
    const convs = await prisma.conversation.findMany({
      where: { gmailThreadId: { in: threadIds.slice(i, i + 1000) }, messages: { some: { direction: 'INBOUND', classification: 'HUMAN_REPLY' } } },
      select: { gmailThreadId: true },
    });
    for (const c of convs) for (const email of (c.gmailThreadId ? threadsOf.get(c.gmailThreadId) : undefined) ?? []) by.get(email)!.replied = true;
  }

  // Opens: a person (not a link scanner) opened the email of their latest round.
  const opens = await prisma.emailTrackingEvent.findMany({
    where: { automated: false, type: 'OPEN', campaignId: { in: [...new Set([...by.values()].map((c) => c.sourceCampaignId))] } },
    distinct: ['campaignId', 'email'],
    select: { campaignId: true, email: true },
  });
  const opened = new Set(opens.map((o) => `${o.campaignId}|${lower(o.email)}`));
  for (const c of by.values()) c.opened = opened.has(`${c.sourceCampaignId}|${c.email}`);

  // Suppression list (unsubscribed, bounced, rejected, complaint…): never included.
  const list = [...by.values()];
  const blocked = await suppressedKeys(workspaceId, list.map((c) => c.email));
  for (const c of list) c.suppressed = blocked.has(emailKey(c.email));
  return list;
}

/** What a follow-up campaign's recipients look like to the compose check: a table the normal path reads. */
export async function followUpTable(input: { workspaceId: string; parentCampaignId: string; emails: string[] }): Promise<
  | { error: string }
  | { headers: string[]; rows: Record<string, string>[]; emailHeader: string; parent: { id: string; rootId: string; round: number; name: string; subject: string } }
> {
  const parent = await prisma.campaign.findFirst({
    where: { id: input.parentCampaignId, workspaceId: input.workspaceId },
    select: { id: true, name: true, status: true, round: true, rootCampaignId: true, datasetId: true, templateVersion: { select: { subject: true } } },
  });
  if (!parent) return { error: 'The send to follow up was not found in your workspace.' };
  if (parent.status !== 'COMPLETED' && parent.status !== 'PARTIALLY_FAILED') return { error: 'Only a send that has finished can be followed up.' };
  const rootId = parent.rootCampaignId ?? parent.id;

  const rootCampaign = await prisma.campaign.findUnique({ where: { id: rootId }, select: { dataset: { select: { columns: { orderBy: { order: 'asc' }, select: { label: true, type: true } } } } } });
  const columns = rootCampaign?.dataset.columns ?? [];
  const emailHeader = columns.find((c) => c.type === 'EMAIL')?.label ?? 'Email';
  const headers = columns.length ? columns.map((c) => c.label) : [emailHeader];

  const candidates = new Map((await chainCandidates(rootId, input.workspaceId)).map((c) => [c.email, c]));
  const wanted = [...new Set(input.emails.map(lower).filter(Boolean))];
  const rows = wanted.map((email) => {
    const c = candidates.get(email);
    const row: Record<string, string> = {};
    for (const h of headers) row[h] = c?.data[h] ?? '';
    row[emailHeader] = email;
    return row;
  });
  return { headers, rows, emailHeader, parent: { id: parent.id, rootId, round: parent.round, name: parent.name, subject: parent.templateVersion.subject } };
}

/** How one person's follow-up email will go out. */
export interface JobPlan {
  accountId: string;
  accountEmail: string;
  accountName: string | null;
  /** Reply in this Gmail thread (null: a new thread). */
  replyThreadId: string | null;
  /** The earlier email (job) it replies to. */
  inReplyToJobId: string | null;
  /** Waiting for a mailbox this sender may not use (not theirs, not shared as a backup). */
  blockedBy: string | null;
}

/**
 * Per person: the mailbox and thread of their last email. A mailbox may be used if it is the
 * sender's own or a shared backup. Not usable: WAIT can't be honoured (blockedBy), FALLBACK
 * sends from the sender as a new thread. FALLBACK also starts a new thread right away when the
 * earlier mailbox is already disconnected.
 */
export async function planFollowUpJobs(input: {
  rootCampaignId: string;
  organizationId: string;
  onMailboxDown: OnMailboxDown;
  /** THREAD (default): reply in each person's earlier thread. NEW: an individual new email from the sender, no thread. */
  mode?: 'THREAD' | 'NEW';
  sender: { id: string; emailAddress: string; displayName: string | null };
  emails: string[];
}): Promise<Map<string, JobPlan>> {
  const wanted = [...new Set(input.emails.map(lower).filter(Boolean))];
  const plans = new Map<string, JobPlan>();
  const own: Omit<JobPlan, 'replyThreadId' | 'inReplyToJobId' | 'blockedBy'> = { accountId: input.sender.id, accountEmail: input.sender.emailAddress, accountName: input.sender.displayName };
  if (!wanted.length) return plans;
  if (input.mode === 'NEW') {
    for (const email of wanted) plans.set(email, { ...own, replyThreadId: null, inReplyToJobId: null, blockedBy: null });
    return plans;
  }

  const jobs = await prisma.emailJob.findMany({
    where: { campaign: chainWhere(input.rootCampaignId), status: EmailJobStatus.SENT, toEmail: { in: wanted, mode: 'insensitive' } },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    select: { id: true, toEmail: true, emailProviderAccountId: true, gmailThreadId: true, messageIdHeader: true },
  });
  const latest = new Map(jobs.map((j) => [lower(j.toEmail), j]));
  const accountIds = [...new Set(jobs.map((j) => j.emailProviderAccountId).filter((id): id is string => !!id))];
  const accounts = new Map((await prisma.emailProviderAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, emailAddress: true, displayName: true, status: true } })).map((a) => [a.id, a]));
  const shared = await fallbackOptIns(input.organizationId);

  for (const email of wanted) {
    const src = latest.get(email);
    const acct = src?.emailProviderAccountId ? accounts.get(src.emailProviderAccountId) : undefined;
    if (!src || !acct || !src.gmailThreadId || !src.messageIdHeader) {
      plans.set(email, { ...own, replyThreadId: null, inReplyToJobId: null, blockedBy: null });
      continue;
    }
    const usable = acct.id === input.sender.id || shared.has(acct.id);
    if (usable && (acct.status === 'CONNECTED' || input.onMailboxDown === 'WAIT')) {
      plans.set(email, { accountId: acct.id, accountEmail: acct.emailAddress, accountName: acct.displayName, replyThreadId: src.gmailThreadId, inReplyToJobId: src.id, blockedBy: null });
    } else if (input.onMailboxDown === 'WAIT') {
      plans.set(email, { accountId: acct.id, accountEmail: acct.emailAddress, accountName: acct.displayName, replyThreadId: src.gmailThreadId, inReplyToJobId: src.id, blockedBy: acct.emailAddress });
    } else {
      plans.set(email, { ...own, replyThreadId: null, inReplyToJobId: null, blockedBy: null });
    }
  }
  return plans;
}

export function planSummary(plans: Map<string, JobPlan>): { replying: number; newThread: number; blocked: string[] } {
  let replying = 0;
  let newThread = 0;
  const blocked = new Set<string>();
  for (const p of plans.values()) {
    if (p.blockedBy) blocked.add(p.blockedBy);
    else if (p.replyThreadId) replying++;
    else newThread++;
  }
  return { replying, newThread, blocked: [...blocked] };
}

/**
 * Has someone answered in this Gmail thread since the follow-up was prepared? A follow-up is for
 * people who have not replied, so one who answers meanwhile (it may be scheduled for later, or wait
 * its turn in a long queue) is not emailed.
 */
export async function repliedSince(threadId: string, since: Date): Promise<boolean> {
  const hit = await prisma.conversation.findFirst({
    where: { gmailThreadId: threadId, messages: { some: { direction: 'INBOUND', classification: 'HUMAN_REPLY', sentAt: { gte: since } } } },
    select: { id: true },
  });
  return !!hit;
}

/** In-Reply-To and References for a follow-up email: the earlier email and every email before it. */
export async function threadHeaders(inReplyToJobId: string): Promise<{ inReplyTo: string; references: string } | null> {
  const ids: string[] = [];
  let id: string | null = inReplyToJobId;
  for (let hops = 0; id && hops < 25; hops++) {
    const j: { messageIdHeader: string | null; inReplyToJobId: string | null } | null = await prisma.emailJob.findUnique({ where: { id }, select: { messageIdHeader: true, inReplyToJobId: true } });
    if (!j) break;
    if (j.messageIdHeader) ids.push(j.messageIdHeader);
    id = j.inReplyToJobId;
  }
  if (!ids.length) return null;
  return { inReplyTo: ids[0]!, references: [...ids].reverse().join(' ') };
}

export type { FollowUpSegment };
