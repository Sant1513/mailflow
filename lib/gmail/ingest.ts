import { prisma } from '@/lib/db/client';
import { classifyInbound, countsAsReply } from '@/lib/conversations/classify';
import { classifyStoredMessage } from '@/lib/ai/context';
import { normalizeSubject, type ParsedMessage } from '@/lib/gmail/parseMessage';
import { MessageDirection, MessageClassification, type EmailProviderAccount } from '@prisma/client';

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

  // Our own sent mail shows up in history too. Outbound is recorded at send
  // time by processEmailJob, so a copy from the SENT label is not a reply.
  if (fromEmail === ownAddress || message.labelIds.includes('SENT')) {
    return { status: 'OUTBOUND_ALREADY_RECORDED' };
  }

  // ── Resolve the conversation this belongs to ──
  const knownThread = await prisma.conversation.findUnique({
    where: {
      emailProviderAccountId_gmailThreadId: {
        emailProviderAccountId: account.id,
        gmailThreadId: message.gmailThreadId,
      },
    },
  });

  let contactId = knownThread?.contactId ?? null;

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

    if (!contactId && fromEmail) {
      // Rule 3: an unsolicited message from someone we already have on file.
      const contact = await prisma.contact.findUnique({
        where: { workspaceId_primaryEmail: { workspaceId: account.workspaceId, primaryEmail: fromEmail } },
        select: { id: true },
      });
      contactId = contact?.id ?? null;
    }

    if (!contactId) {
      return { status: 'IGNORED', reason: `Not a MailFlow thread and ${fromEmail || 'sender'} is not a known contact.` };
    }
  }

  // ── Classify ──
  const cls = classifyInbound(message);
  const isReply = countsAsReply(cls.classification);

  const result = await prisma.$transaction(async (tx) => {
    let conversation = knownThread;
    let created = false;

    if (!conversation) {
      conversation = await tx.conversation.create({
        data: {
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
          workspaceId: account.workspaceId,
          userId: conversation.assigneeId ?? account.userId,
          type: 'NEW_REPLY',
          title: `New reply from ${message.from?.name ?? fromEmail}`,
          body: message.snippet.slice(0, 200),
          link: `/inbox/${conversation.id}`,
        },
      });
    }

    return { conversationId: conversation.id, messageId: stored.id, created };
  },
  // Six round trips against a hosted database can exceed Prisma's 5s
  // default interactive-transaction timeout (P2028), which would drop
  // every inbound reply. The work is bounded, so a generous ceiling is safe.
  { timeout: 30_000, maxWait: 10_000 });

  if (isReply) {
    // §80 AI intent, stored beside the header-first result. Best effort:
    // AI being off, over limit or slow never delays or fails ingestion.
    await classifyStoredMessage(result.messageId, {
      userId: account.userId,
      organizationId: account.organizationId,
      workspaceId: account.workspaceId,
    });
  }

  return { status: 'STORED', ...result, classification: cls.classification };
}
