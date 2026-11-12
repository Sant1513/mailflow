import { prisma } from '@/lib/db/client';
import { parseGmailMessage, type GmailMessage } from '@/lib/gmail/parseMessage';
import { classifyInbound } from '@/lib/conversations/classify';
import { parseDeliveryReport, isComplaintReport } from '@/lib/email/dsn';
import { applyAction, planDeliveryReport, type NdrAction } from '@/lib/email/ndr';

/**
 * The core of scripts/backfill-ndr.ts, kept here so it can be tested: one bounce notice from a
 * mailbox → what it says and what would be done (dry run), or done (apply). Same parser and
 * rules as live sync (lib/gmail/ingest.ts), so a backfilled notice ends up exactly as if sync had
 * caught it at the time.
 */

/** Gmail search for bounce / delivery notices in the last `days` days. */
export function ndrSearchQuery(days = 30): string {
  return `newer_than:${days}d (from:(mailer-daemon OR postmaster) OR subject:(undeliverable OR "not delivered" OR "couldn't be delivered" OR "message blocked" OR "delivery status notification" OR "returned mail" OR "failure notice"))`;
}

export interface NoticeResult {
  gmailMessageId: string;
  subject: string;
  from: string | null;
  receivedAt: Date;
  /** Not a delivery report after all (e.g. a newsletter whose subject matched the search). */
  skipped?: string;
  actions: NdrAction[];
}

export async function processNotice(
  account: { id: string; emailAddress: string; workspaceId: string; organizationId: string },
  raw: GmailMessage,
  options: { apply: boolean; includeOutside?: boolean; ownDomains?: string[] },
): Promise<NoticeResult> {
  const message = parseGmailMessage(raw);
  const base = { gmailMessageId: message.gmailMessageId, subject: message.subject, from: message.from?.email ?? null, receivedAt: message.receivedAt };
  const cls = classifyInbound(message);
  const isBounce = cls.classification === 'BOUNCE' || cls.classification === 'DELIVERY_FAILURE';
  if (!isBounce && !isComplaintReport(message)) return { ...base, skipped: `not a delivery report (${cls.classification})`, actions: [] };
  const report = parseDeliveryReport(message, [account.emailAddress], { assumeReport: isBounce });
  if (!report) return { ...base, skipped: 'unreadable report', actions: [] };

  const conversation = await prisma.conversation.findUnique({
    where: { emailProviderAccountId_gmailThreadId: { emailProviderAccountId: account.id, gmailThreadId: message.gmailThreadId } },
    select: { workspaceId: true, recipientEmail: true },
  });
  const ctx = { account, report, gmailMessageId: message.gmailMessageId, gmailThreadId: message.gmailThreadId, receivedAt: message.receivedAt, conversation };
  const planned = await planDeliveryReport(ctx);
  const actions = options.includeOutside ? planned.map((a) => outsideMailFlow(a, account, options.ownDomains ?? [])) : planned;
  if (options.apply) for (const a of actions) await applyAction(a, ctx);
  return { ...base, actions };
}

/** Failures that mean the address is dead or refuses us, whoever sent the email. */
const OUTSIDE_SUPPRESS = new Set(['USER_UNKNOWN', 'DOMAIN_NOT_FOUND', 'MAILBOX_DISABLED', 'POLICY_BLOCK', 'SPAM_BLOCK', 'OTHER_HARD', 'LEFT_COMPANY', 'COMPLAINT']);

/**
 * --include-outside: a hard bounce on an email this mailbox sent outside MailFlow (plain Gmail,
 * another mail-merge tool) still tells us the address is dead or blocks us, so it is suppressed
 * in the mailbox owner's workspace (and copied org-wide like any hard bounce). Never for delays,
 * full mailboxes or too-large messages, and never for our own domains.
 */
export function outsideMailFlow(a: NdrAction, account: { emailAddress: string; workspaceId: string }, ownDomains: string[]): NdrAction {
  if (a.decision !== 'NO_MATCH' || !a.email || !OUTSIDE_SUPPRESS.has(a.category)) return a;
  const domain = a.email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain || ownDomains.includes(domain) || a.email.toLowerCase() === account.emailAddress.toLowerCase()) return a;
  return { ...a, decision: 'SUPPRESS', workspaceId: account.workspaceId, send: null, sourceLabel: `Bounce notice on an email sent outside MailFlow from ${account.emailAddress}` };
}
