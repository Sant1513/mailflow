import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadConversationForSession } from '@/lib/conversations/access';
import { GmailProvider } from '@/lib/email/gmail';
import { SendEmailError } from '@/lib/email/provider';
import { buildReferences } from '@/lib/email/mime';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { MessageDirection, EmailProvider as EmailProviderEnum } from '@prisma/client';

const replySchema = z.object({
  html: z.string().min(1, 'Reply body is required'),
  plainText: z.string().optional(),
  /** Override the subject; defaults to "Re: <thread subject>". */
  subject: z.string().max(500).optional(),
  cc: z.array(z.string().email()).max(25).default([]),
  /**
   * §54: continue the existing Gmail thread (default) or start a fresh one.
   * A new thread is a deliberate choice — it must never happen by accident.
   */
  newThread: z.boolean().default(false),
});

/**
 * §53 reply from the app, in the same Gmail thread as the student's message.
 * Threading is done properly: In-Reply-To names the message being answered
 * and References carries the whole chain, so it threads in every client, not
 * just Gmail (§46).
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const conversation = await loadConversationForSession(session, params.id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = replySchema.parse(await req.json());

  // Reply from the caller's OWN mailbox, not the conversation's original
  // account — a SUPER_ADMIN viewing another workspace cannot send as them.
  if (!session.workspaceId) throw new ForbiddenError('No workspace on session');
  const sender = await prisma.emailProviderAccount.findUnique({
    where: {
      workspaceId_userId_provider: {
        workspaceId: session.workspaceId,
        userId: session.userId,
        provider: EmailProviderEnum.GMAIL,
      },
    },
  });
  if (!sender || sender.status !== 'CONNECTED') {
    return NextResponse.json({ error: 'Connect your Gmail account in Settings before replying.' }, { status: 400 });
  }
  if (sender.id !== conversation.emailProviderAccountId) {
    // The thread lives in a different mailbox; Gmail will not let this
    // account continue it. Force a new thread rather than fail confusingly.
    if (!body.newThread) {
      return NextResponse.json(
        { error: 'This conversation belongs to a different mailbox than yours. Send as a new email instead.', requiresNewThread: true },
        { status: 409 }
      );
    }
  }

  // The most recent message decides what we are replying to.
  const last = conversation.messages[conversation.messages.length - 1] ?? null;
  const inReplyTo = body.newThread ? null : (last?.messageIdHeader ?? null);
  const references = body.newThread ? null : buildReferences(last?.references ?? null, last?.messageIdHeader ?? null);
  const threadId = body.newThread ? null : conversation.gmailThreadId;

  const baseSubject = conversation.subject.replace(/^\s*(re|fwd?)\s*:\s*/i, '');
  const subject = body.subject?.trim() || (body.newThread ? baseSubject : `Re: ${baseSubject}`);
  const fromName = sender.displayName ?? session.name;

  let result;
  try {
    const provider = new GmailProvider(sender);
    result = await provider.sendEmail({
      to: conversation.recipientEmail,
      cc: body.cc,
      fromName,
      fromEmail: sender.emailAddress,
      subject,
      html: body.html,
      plainText: body.plainText,
      threadId,
      inReplyTo,
      references,
    });
  } catch (err) {
    const e = err instanceof SendEmailError ? err : null;
    return NextResponse.json(
      {
        error: e?.message ?? 'Failed to send the reply.',
        kind: e?.kind,
        hint: e?.kind === 'AUTH' ? 'Reconnect Gmail in Settings.' : undefined,
      },
      { status: 502 }
    );
  }

  const now = new Date();
  const stored = await prisma.$transaction(async (tx) => {
    // A brand-new thread is a brand-new conversation (§54).
    const target =
      body.newThread && result.threadId
        ? await tx.conversation.create({
            data: {
              organizationId: conversation.organizationId,
              workspaceId: conversation.workspaceId,
              ownerId: session.userId,
              contactId: conversation.contactId,
              recipientEmail: conversation.recipientEmail,
              subject,
              emailProviderAccountId: sender.id,
              gmailThreadId: result.threadId,
              firstMessageAt: now,
              lastMessageAt: now,
              messageCount: 0,
              status: 'WAITING_FOR_STUDENT',
            },
          })
        : conversation;

    const message = await tx.conversationMessage.create({
      data: {
        conversationId: target.id,
        gmailMessageId: result.providerMessageId,
        gmailThreadId: result.threadId,
        direction: MessageDirection.OUTBOUND,
        senderEmail: sender.emailAddress,
        senderName: fromName,
        recipientEmail: conversation.recipientEmail,
        cc: body.cc,
        bcc: [],
        subject,
        messageIdHeader: result.messageIdHeader,
        inReplyTo,
        references: buildReferences(references, result.messageIdHeader),
        // §89 immutable snapshot of exactly what was sent.
        htmlBody: body.html,
        plainTextBody: body.plainText ?? null,
        snippet: sanitizeEmailHtml(body.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
        sentAt: now,
        status: 'SENT',
        isRead: true,
      },
    });

    await tx.conversation.update({
      where: { id: target.id },
      data: {
        lastMessageAt: now,
        messageCount: { increment: 1 },
        unread: false,
        // We just wrote to them; the ball is in their court.
        status: target.status === 'RESOLVED' || target.status === 'CLOSED' ? target.status : 'WAITING_FOR_STUDENT',
      },
    });

    await tx.record.updateMany({
      where: { contactId: conversation.contactId },
      data: { lastCommunicationAt: now, lastCommunicationDirection: 'OUTBOUND', unreadReply: false },
    });

    await tx.recipientHistory.create({
      data: {
        contactId: conversation.contactId,
        type: 'MANUAL_REPLY',
        summary: `${session.name} replied: "${subject}"`,
        refId: message.id,
      },
    });

    return { conversationId: target.id, messageId: message.id };
  },
  // Same reasoning as ingest: several round trips against a hosted DB can
  // exceed the 5s default (P2028), and losing the record of a reply that
  // Gmail already accepted would leave history wrong.
  { timeout: 30_000, maxWait: 10_000 });

  await audit(session, body.newThread ? 'CONVERSATION_NEW_EMAIL' : 'CONVERSATION_REPLY', {
    targetType: 'Conversation',
    targetId: stored.conversationId,
    metadata: { gmailMessageId: result.providerMessageId, threadId: result.threadId },
  });

  return NextResponse.json({
    sent: true,
    ...stored,
    gmailMessageId: result.providerMessageId,
    gmailThreadId: result.threadId,
    newThread: body.newThread,
  });
});
