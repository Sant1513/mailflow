import { prisma } from '@/lib/db/client';
import { classifyInbound, countsAsReply } from '@/lib/conversations/classify';
import { classifyStoredMessage } from '@/lib/ai/context';
import { triageReply } from '@/lib/ai/triage';
import { normalizeSubject, type ParsedMessage } from '@/lib/gmail/parseMessage';
import { MessageDirection, MessageClassification, type EmailProviderAccount } from '@prisma/client';
import { dispatchWebhook } from '@/lib/webhooks/dispatch';
import { detectLeftCompany, isComplaintReport, leftCompanyReport, parseDeliveryReport, type DeliveryReport } from '@/lib/email/dsn';
import { applyDeliveryReport, willSuppress, type NdrAction } from '@/lib/email/ndr';
import { handleUnsubscribeEmail, parseUnsubscribeSubject } from '@/lib/email/unsubscribeByEmail';
import { cleanName } from '@/lib/contacts/names';
import { applyReplyRules } from '@/lib/replyRules/apply';
import { findRecruiterSend, markRecruiterReplied, recruiterContact, recruiterThreadKey, type RecruiterReplyMatch } from '@/lib/recruiterSend/replies';

/**
 * §47-§50 inbound ingestion. Given an already-parsed Gmail message and the
 * mailbox it arrived in, decides whether it belongs to MailFlow and, if so,
 * records it in the right conversation.
 *
 * Identity (§45): a conversation IS (emailProviderAccountId, gmailThreadId).
 * Never subject, never sender address alone — two students can share a
 * subject line, and one student can be in several threads.
 *
 * Scope (§104): we do NOT import the whole mailbox. A message is ingested
 * only when it can be tied to something MailFlow started:
 *   1. its thread is already a MailFlow conversation, or
 *   2. it replies to a Message-ID MailFlow sent (In-Reply-To/References), or
 *   3. it is from a known Contact in this workspace (a fresh, unsolicited
 *      message from a student we already mail).
 * Anything else — newsletters, colleagues, personal mail — is left alone.
 *
 * Idempotent (§48): ConversationMessage.gmailMessageId is unique, so the
 * same Pub/Sub notification delivered twice records the message once.
 */

/**
 * Something that must happen for this message (suppressing a bounce, an unsubscribe) failed for
 * a reason that may pass. The message is left un-ingested, and the sync keeps its Gmail cursor
 * before it, so the next run tries again instead of losing it (lib/gmail/sync.ts).
 */
export class RetryLaterError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

export type IngestOutcome =
  | { status: 'STORED'; conversationId: string; messageId: string; classification: string; created: boolean }
  | { status: 'DUPLICATE'; messageId: string }
  | { status: 'OUTBOUND_ALREADY_RECORDED' }
  | { status: 'IGNORED'; reason: string };

type AccountShape = Pick<EmailProviderAccount, 'id' | 'emailAddress' | 'workspaceId' | 'organizationId' | 'userId'>;

function toEnum(value: string): MessageClassification {
  return (MessageClassification as Record<string, MessageClassification>)[value] ?? MessageClassification.UNKNOWN;
}

export async function ingestInboundMessage(account: AccountShape, message: ParsedMessage): Promise<IngestOutcome> {
  // Already have it? (webhook redelivery, overlapping history windows)
  const existing = await prisma.conversationMessage.findUnique({
    where: { gmailMessageId: message.gmailMessageId },
    select: { id: true },
  });
  if (existing) return { status: 'DUPLICATE', messageId: existing.id };

  const fromEmail = message.from?.email ?? '';
  const ownAddress = account.emailAddress.toLowerCase();

  // Our own sent mail shows up in history too. Sends made through MailFlow
  // are recorded at send time (deduplicated above by gmailMessageId). A
  // message the team sent straight from Gmail in a thread we know is stored
  // as OUTBOUND so the conversation stays complete; it never counts as a
  // reply, never notifies, never classifies (§50).
  if (fromEmail === ownAddress || message.labelIds.includes('SENT')) {
    const thread = await prisma.conversation.findUnique({
      where: { emailProviderAccountId_gmailThreadId: { emailProviderAccountId: account.id, gmailThreadId: message.gmailThreadId } },
    });
    if (!thread) return { status: 'OUTBOUND_ALREADY_RECORDED' };
    const outbound = await prisma.$transaction(async (tx) => {
      const stored = await tx.conversationMessage.create({
        data: {
          conversationId: thread.id,
          gmailMessageId: message.gmailMessageId,
          gmailThreadId: message.gmailThreadId,
          direction: MessageDirection.OUTBOUND,
          classification: 'UNKNOWN',
          senderEmail: ownAddress,
          senderName: message.from?.name ?? null,
          recipientEmail: message.to[0]?.email ?? thread.recipientEmail,
          cc: message.cc.map((a) => a.email),
          bcc: [],
          subject: message.subject,
          messageIdHeader: message.messageIdHeader,
          inReplyTo: message.inReplyTo,
          references: message.references,
          htmlBody: message.htmlBody,
          plainTextBody: message.plainTextBody,
          snippet: message.snippet,
          sentAt: message.sentAt,
          status: 'SENT',
          isRead: true,
          hasAttachments: message.attachments.length > 0,
        },
      });
      await tx.conversation.update({
        where: { id: thread.id },
        data: { lastMessageAt: message.sentAt, messageCount: { increment: 1 } },
      });
      await tx.record.updateMany({ where: { contactId: thread.contactId }, data: { lastCommunicationAt: message.sentAt, lastCommunicationDirection: 'OUTBOUND' } });
      await tx.recipientHistory.create({
        data: { contactId: thread.contactId, type: 'MANUAL_REPLY', summary: `Replied from Gmail: "${message.subject.slice(0, 80)}"`, refId: stored.id, createdAt: message.sentAt },
      });
      return stored;
    });
    return { status: 'STORED', conversationId: thread.id, messageId: outbound.id, classification: 'OUTBOUND', created: false };
  }

  // ── Unsubscribe by email ──
  // Gmail's Unsubscribe button and the button in our emails send "Unsubscribe <code>" from the
  // recipient to the sending mailbox: the only way a BCC email can say who unsubscribed
  // (lib/email/unsubscribeByEmail.ts). Suppress them; it isn't a conversation.
  const unsubscribe = parseUnsubscribeSubject(message.subject);
  if (unsubscribe && fromEmail) {
    // Nothing is stored for an unsubscribe email, so a failure here must reach the sync: it keeps
    // the message in the next run instead of moving past it and losing the request.
    const done = await handleUnsubscribeEmail(account, fromEmail, unsubscribe).catch((err) => {
      console.error('[ingest] unsubscribe by email failed; will retry', err);
      throw new RetryLaterError(`Unsubscribe by email failed: ${(err as Error).message ?? String(err)}`, err);
    });
    if (done) return { status: 'IGNORED', reason: `Unsubscribe request from ${fromEmail}: ${done.label}.` };
  }

  // ── Resolve the conversation this belongs to ──
  let knownThread = await prisma.conversation.findUnique({
    where: {
      emailProviderAccountId_gmailThreadId: {
        emailProviderAccountId: account.id,
        gmailThreadId: message.gmailThreadId,
      },
    },
  });

  let contactId = knownThread?.contactId ?? null;
  let recruiter: RecruiterReplyMatch | null = null;
  // ── Classify ──
  const cls = classifyInbound(message);
  const isReply = countsAsReply(cls.classification);
  const isBounce = cls.classification === 'BOUNCE' || cls.classification === 'DELIVERY_FAILURE';

  // ── Bounces, spam complaints, "has left the company" auto-replies (lib/email/ndr.ts) ──
  // Acted on before anything is stored: matched to the send it's about (Message-ID, thread, or the
  // failed address + this mailbox's recent sends), suppressed by category, and the send marked
  // bounced. A failure goes back to the sync, which keeps the message for the next run; the
  // writes are idempotent, so a retry never double-counts.
  let report: DeliveryReport | null = null;
  if (isBounce || isComplaintReport(message)) {
    report = parseDeliveryReport(message, [account.emailAddress], { assumeReport: isBounce });
  } else if (!isReply && fromEmail && (cls.classification === 'OUT_OF_OFFICE' || cls.classification === 'AUTO_REPLY')) {
    const phrase = detectLeftCompany(message);
    if (phrase) report = leftCompanyReport(fromEmail, phrase, message);
  }
  let reportActions: NdrAction[] = [];
  if (report) {
    const r = report;
    reportActions = await applyDeliveryReport({
      account,
      report: r,
      gmailMessageId: message.gmailMessageId,
      gmailThreadId: message.gmailThreadId,
      receivedAt: message.receivedAt,
      conversation: knownThread ? { workspaceId: knownThread.workspaceId, recipientEmail: knownThread.recipientEmail } : null,
    }).catch((err) => {
      console.error('[ingest] delivery report handling failed; will retry', err);
      throw new RetryLaterError(`Delivery report handling failed: ${(err as Error).message ?? String(err)}`, err);
    });
  }
  const reportSummary = reportActions.length
    ? reportActions.map((a) => `${a.email ?? '?'} ${a.category}${willSuppress(a.decision) ? ' (suppressed)' : ` (${a.decision.toLowerCase()})`}`).join(', ')
    : 'nothing matched';

  if (!knownThread) {
    // Not a known thread. Does it answer something we sent?
    const referenced = [message.inReplyTo, ...(message.references ?? '').split(/\s+/)]
      .map((s) => s?.trim())
      .filter((s): s is string => !!s);

    if (referenced.length > 0) {
      const parentJob = await prisma.emailJob.findFirst({
        where: { messageIdHeader: { in: referenced }, emailProviderAccountId: account.id },
        select: { record: { select: { contactId: true } } },
      });
      contactId = parentJob?.record.contactId ?? null;
    }

    // A reply to a Recruiter Bulk Send goes to the admin who sent it, one conversation per
    // recruiter, not to the owner of the mailbox that carried it (lib/recruiterSend/replies.ts).
    const recruiterSend = contactId ? null : await findRecruiterSend(account, referenced, message.gmailThreadId);
    if (recruiterSend) {
      if (isBounce) {
        // Already suppressed and marked "bounced" on the send's page above; not a conversation.
        return { status: 'IGNORED', reason: `Bounce from a recruiter send: ${reportSummary}.` };
      }
      if (!fromEmail) return { status: 'IGNORED', reason: 'Recruiter reply without a sender address.' };
      knownThread = await prisma.conversation.findUnique({
        where: { emailProviderAccountId_gmailThreadId: { emailProviderAccountId: account.id, gmailThreadId: recruiterThreadKey(message.gmailThreadId, fromEmail) } },
      });
      // Out-of-office and other automatic answers to a bulk send don't open a conversation.
      if (!knownThread && !isReply) return { status: 'IGNORED', reason: `Automatic answer (${cls.classification}) to a recruiter send.` };
      contactId = knownThread?.contactId ?? (await recruiterContact(recruiterSend, fromEmail, message.from?.name ?? null));
      recruiter = recruiterSend;
    }

    // Rule 3 (removed): we no longer accept unsolicited messages from known
    // contacts. Doing so imported every email that arrived in the mailbox from
    // someone who ever received a campaign — which is the opposite of what the
    // inbox is for. We only track threads that MailFlow started or that the
    // student started in direct reply to something MailFlow sent (Rule 2).
    if (!contactId) {
      if (report) return { status: 'IGNORED', reason: `${report.kind === 'BOUNCE' ? 'Delivery report' : report.kind === 'COMPLAINT' ? 'Spam complaint' : 'Automatic reply'}: ${reportSummary}.` };
      return { status: 'IGNORED', reason: `Not a MailFlow thread and the message does not reply to a message MailFlow sent.` };
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    let conversation = knownThread;
    let created = false;

    if (!conversation) {
      conversation = await tx.conversation.create({
        data: recruiter
          ? {
              // The admin's conversation, assigned to them, whichever mailbox carried the send.
              organizationId: recruiter.organizationId,
              workspaceId: recruiter.workspaceId,
              ownerId: recruiter.adminId,
              assigneeId: recruiter.adminId,
              recruiterBlastId: recruiter.blastId,
              contactId: contactId!,
              recipientEmail: fromEmail.toLowerCase(),
              subject: normalizeSubject(message.subject) || '(no subject)',
              emailProviderAccountId: account.id,
              gmailThreadId: recruiterThreadKey(message.gmailThreadId, fromEmail),
              firstMessageAt: message.sentAt,
              lastMessageAt: message.sentAt,
              messageCount: 0,
              unread: false,
            }
          : {
              organizationId: account.organizationId,
              workspaceId: account.workspaceId,
              ownerId: account.userId,
              contactId: contactId!,
              recipientEmail: fromEmail,
              subject: normalizeSubject(message.subject) || '(no subject)',
              emailProviderAccountId: account.id,
              gmailThreadId: message.gmailThreadId,
              firstMessageAt: message.sentAt,
              lastMessageAt: message.sentAt,
              messageCount: 0,
              unread: false,
            },
      });
      created = true;
    }
    // Recruiter conversations notify and act as the admin, in the admin's workspace.
    const forAdmin = !!conversation.recruiterBlastId;
    const notifyWorkspaceId = forAdmin ? conversation.workspaceId : account.workspaceId;
    const fallbackUserId = forAdmin ? conversation.ownerId : account.userId;

    const stored = await tx.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        gmailMessageId: message.gmailMessageId,
        gmailThreadId: message.gmailThreadId,
        direction: MessageDirection.INBOUND,
        classification: toEnum(cls.classification),
        classificationConfidence: cls.confidence,
        senderEmail: fromEmail,
        senderName: message.from?.name ?? null,
        recipientEmail: message.to[0]?.email ?? ownAddress,
        cc: message.cc.map((a) => a.email),
        bcc: [],
        subject: message.subject,
        messageIdHeader: message.messageIdHeader,
        inReplyTo: message.inReplyTo,
        references: message.references,
        // §90: the exact received body, never reconstructed later.
        htmlBody: message.htmlBody,
        plainTextBody: message.plainTextBody,
        snippet: message.snippet,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
        status: 'RECEIVED',
        isRead: false,
        hasAttachments: message.attachments.length > 0,
        attachments: {
          create: message.attachments.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            gmailAttachmentId: a.gmailAttachmentId,
          })),
        },
      },
    });

    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: message.sentAt,
        messageCount: { increment: 1 },
        // Only a human reply lights up the inbox (§52). A bounce is still
        // stored, but it is not "unread mail from a student".
        ...(isReply ? { unread: true, status: 'OPEN' } : {}),
      },
    });

    // §14 system fields on every record linked to this contact. Business
    // columns are never touched.
    if (isReply) {
      await tx.record.updateMany({
        where: { contactId: conversation.contactId },
        data: {
          replyReceived: true,
          replyReceivedAt: message.sentAt,
          lastReplyAt: message.sentAt,
          lastCommunicationAt: message.sentAt,
          lastCommunicationDirection: 'INBOUND',
          unreadReply: true,
          conversationId: conversation.id,
          gmailThreadId: message.gmailThreadId,
        },
      });
    }

    await tx.recipientHistory.create({
      data: {
        contactId: conversation.contactId,
        type: isReply ? 'REPLY' : 'AUTOMATED_MESSAGE',
        summary: isReply
          ? `Replied: "${message.snippet.slice(0, 120)}"`
          : `${cls.classification.replace(/_/g, ' ').toLowerCase()}: "${message.subject.slice(0, 80)}"`,
        refId: stored.id,
        createdAt: message.sentAt,
      },
    });

    if (isReply) {
      // §87 notify the conversation owner (or assignee).
      await tx.notification.create({
        data: {
          workspaceId: notifyWorkspaceId,
          userId: conversation.assigneeId ?? fallbackUserId,
          type: 'NEW_REPLY',
          title: `New reply from ${message.from?.name ?? fromEmail}`,
          body: message.snippet.slice(0, 200),
          link: `/inbox/${conversation.id}`,
        },
      });
    }

    return {
      conversationId: conversation.id,
      messageId: stored.id,
      created,
      owner: { workspaceId: notifyWorkspaceId, userId: fallbackUserId, recruiterBlastId: conversation.recruiterBlastId, conversationWorkspaceId: conversation.workspaceId },
    };
  },
  // Six round trips against a hosted database can exceed Prisma's 5s
  // default interactive-transaction timeout (P2028), which would drop
  // every inbound reply. The work is bounded, so a generous ceiling is safe.
  { timeout: 30_000, maxWait: 10_000 });

  // Bounce notices were already acted on above, before storing (lib/email/ndr.ts).
  const { owner, ...stored } = result;

  if (isReply) {
    // Their display name ("Bhuvan C <…>") for a contact that has none (never overwrites).
    const replyName = cleanName(message.from?.name);
    if (replyName) {
      await prisma.contact
        .updateMany({ where: { primaryEmail: { equals: fromEmail, mode: 'insensitive' }, organizationId: account.organizationId, name: null }, data: { name: replyName } })
        .catch((err) => console.error('[ingest] contact name fill failed', err));
    }
    if (owner.recruiterBlastId) {
      await markRecruiterReplied(owner.recruiterBlastId, fromEmail, message.sentAt).catch((err) => console.error('[ingest] recruiter replied mark failed', err));
    }
    // §80 AI intent, stored beside the header-first result. Best effort:
    // AI being off, over limit or slow never delays or fails ingestion.
    const aiCtx = { userId: owner.userId, organizationId: account.organizationId, workspaceId: owner.workspaceId };
    const intent = await classifyStoredMessage(result.messageId, aiCtx);
    // AI triage (tag, assign, close thank-yous, draft an answer): best effort, per-org settings.
    if (intent) {
      await triageReply({
        messageId: result.messageId,
        conversationId: result.conversationId,
        intent: intent.intent,
        confidence: intent.confidence,
        ai: aiCtx,
        mailboxEmail: account.emailAddress,
      });
      // The campaign's "When someone replies" rules (lib/replyRules), after triage so a rule's
      // own choices (status, assignee, template reply) win over the generic ones.
      await applyReplyRules({ conversationId: result.conversationId, intent: intent.intent, confidence: intent.confidence });
    }

    dispatchWebhook(owner.workspaceId, 'conversation.message.received', {
      conversationId: result.conversationId,
      messageId: result.messageId,
      senderEmail: fromEmail,
      classification: cls.classification,
    }).catch(() => undefined);
  }

  return { status: 'STORED', ...stored, classification: cls.classification };
}
