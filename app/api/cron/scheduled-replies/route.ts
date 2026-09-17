import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { GmailProvider } from '@/lib/email/gmail';
import { SendEmailError } from '@/lib/email/provider';
import { buildReferences, buildQuotedTrail } from '@/lib/email/mime';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { MessageDirection, EmailProvider as EmailProviderEnum } from '@prisma/client';

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}` || new URL(req.url).searchParams.get('secret') === secret;
}

/**
 * Cron: fire PENDING scheduled replies whose scheduledFor has passed.
 * Runs daily; same auth pattern as /api/cron/scheduled-send.
 */
export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const now = new Date();

  const pending = await prisma.scheduledReply.findMany({
    where: { status: 'PENDING', scheduledFor: { lte: now } },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { sentAt: 'asc' } },
        },
      },
    },
  });

  if (pending.length === 0) return NextResponse.json({ sent: 0, failed: 0 });

  let sent = 0;
  let failed = 0;

  for (const reply of pending) {
    const conversation = reply.conversation;

    // Find the Gmail account for this conversation's workspace + original account.
    const sender = await prisma.emailProviderAccount.findUnique({
      where: { id: conversation.emailProviderAccountId },
    });

    if (!sender || sender.status !== 'CONNECTED') {
      await prisma.scheduledReply.update({
        where: { id: reply.id },
        data: { status: 'FAILED', errorMessage: 'Sender account not connected' },
      });
      failed++;
      continue;
    }

    const last = conversation.messages[conversation.messages.length - 1] ?? null;
    const inReplyTo = reply.newThread ? null : (last?.messageIdHeader ?? null);
    const references = reply.newThread ? null : buildReferences(last?.references ?? null, last?.messageIdHeader ?? null);
    const threadId = reply.newThread ? null : conversation.gmailThreadId;

    const baseSubject = conversation.subject.replace(/^\s*(re|fwd?)\s*:\s*/i, '');
    const subject = reply.newThread ? baseSubject : `Re: ${baseSubject}`;
    const fromName = sender.displayName ?? sender.emailAddress;

    const quotedTrail = buildQuotedTrail(conversation.messages, { skipNewThread: reply.newThread });
    const htmlToSend = quotedTrail ? reply.html + quotedTrail : reply.html;

    let result;
    try {
      const provider = new GmailProvider(sender);
      result = await provider.sendEmail({
        to: conversation.recipientEmail,
        cc: reply.cc,
        fromName,
        fromEmail: sender.emailAddress,
        subject,
        html: htmlToSend,
        plainText: reply.plainText,
        threadId,
        inReplyTo,
        references,
      });
    } catch (err) {
      const message = err instanceof SendEmailError ? err.message : err instanceof Error ? err.message : 'Unknown error';
      await prisma.scheduledReply.update({
        where: { id: reply.id },
        data: { status: 'FAILED', errorMessage: message },
      });
      failed++;
      continue;
    }

    const sentAt = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        // A brand-new thread creates a new conversation.
        const target =
          reply.newThread && result.threadId
            ? await tx.conversation.create({
                data: {
                  organizationId: conversation.organizationId,
                  workspaceId: conversation.workspaceId,
                  ownerId: reply.createdById,
                  contactId: conversation.contactId,
                  recipientEmail: conversation.recipientEmail,
                  subject,
                  emailProviderAccountId: sender.id,
                  gmailThreadId: result.threadId,
                  firstMessageAt: sentAt,
                  lastMessageAt: sentAt,
                  messageCount: 0,
                  status: 'WAITING_FOR_STUDENT',
                },
              })
            : conversation;

        await tx.conversationMessage.create({
          data: {
            conversationId: target.id,
            gmailMessageId: result.providerMessageId,
            gmailThreadId: result.threadId,
            direction: MessageDirection.OUTBOUND,
            senderEmail: sender.emailAddress,
            senderName: fromName,
            recipientEmail: conversation.recipientEmail,
            cc: reply.cc,
            bcc: [],
            subject,
            messageIdHeader: result.messageIdHeader,
            inReplyTo,
            references: buildReferences(references, result.messageIdHeader),
            htmlBody: htmlToSend,
            plainTextBody: reply.plainText,
            snippet: sanitizeEmailHtml(reply.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
            sentAt,
            status: 'SENT',
            isRead: true,
          },
        });

        await tx.conversation.update({
          where: { id: target.id },
          data: {
            lastMessageAt: sentAt,
            messageCount: { increment: 1 },
            unread: false,
            status: target.status === 'RESOLVED' || target.status === 'CLOSED' ? target.status : 'WAITING_FOR_STUDENT',
          },
        });

        await tx.scheduledReply.update({
          where: { id: reply.id },
          data: { status: 'SENT', sentAt },
        });
      }, { timeout: 30_000, maxWait: 10_000 });

      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      await prisma.scheduledReply.update({
        where: { id: reply.id },
        data: { status: 'FAILED', errorMessage: message },
      });
      failed++;
    }
  }

  return NextResponse.json({ sent, failed, total: pending.length });
}
