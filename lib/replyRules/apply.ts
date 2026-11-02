import { waitUntil } from '@vercel/functions';
import { ColumnType, ConversationStatus, Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { appBaseUrl } from '@/lib/app-url';
import { ensureColumns, updateRecordFields } from '@/lib/records/systemUpdate';
import { columnKeyFor } from '@/lib/rsvp/respond';
import { renderTemplate, htmlToPlainText } from '@/lib/templates/variables';
import { tagConversation, AI_DRAFT_STATUS } from '@/lib/ai/triage';
import { notifyAssignment } from '@/lib/conversations/notify';
import type { AppSession } from '@/lib/auth/session';
import { pickRule, readReplyRules, REPLY_TYPES, type ReplyRule } from '@/lib/replyRules/config';

const ACTOR = 'MailFlow reply rules';

/** Sends due scheduled replies now instead of waiting for the next scheduled run. */
function kickScheduledReplies() {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const base = process.env.INTERNAL_APP_URL?.replace(/\/+$/, '') || appBaseUrl();
  const call = fetch(`${base}/api/cron/scheduled-replies`, { headers: { Authorization: `Bearer ${secret}` } }).catch(() => undefined);
  try {
    waitUntil(call);
  } catch {
    /* not on Vercel: the promise runs on its own */
  }
}

/**
 * Runs the campaign's "When someone replies" rule for a human reply whose intent the AI has
 * just set (lib/gmail/ingest.ts, after triage). Best effort: never fails ingestion.
 * Returns the rule that ran, or null.
 */
export async function applyReplyRules(opts: { conversationId: string; intent: string; confidence: number }): Promise<ReplyRule | null> {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: opts.conversationId },
      select: { id: true, organizationId: true, workspaceId: true, ownerId: true, assigneeId: true, status: true, contactId: true, recipientEmail: true, subject: true, emailProviderAccountId: true, gmailThreadId: true },
    });
    if (!conversation?.gmailThreadId) return null;

    // Which campaign started this thread (and whose row it is).
    const job = await prisma.emailJob.findFirst({
      where: { emailProviderAccountId: conversation.emailProviderAccountId, gmailThreadId: conversation.gmailThreadId },
      orderBy: { createdAt: 'asc' },
      select: { campaignId: true, recordId: true, record: { select: { data: true } }, campaign: { select: { id: true, name: true, createdById: true, datasetId: true, replyRules: true } } },
    });
    const rules = readReplyRules(job?.campaign?.replyRules);
    if (!job?.campaign || !rules) return null;
    const rule = pickRule(rules, opts.intent, opts.confidence);
    if (!rule) return null;
    const a = rule.actions;
    const done: string[] = [];

    if (a.setColumn && job.recordId) {
      const key = columnKeyFor(a.setColumn);
      await ensureColumns(job.campaign.datasetId, [{ key, label: a.setColumn, type: ColumnType.TEXT }]);
      await updateRecordFields({ recordId: job.recordId, fields: { [key]: a.setValue }, reason: `${ACTOR}: reply was "${REPLY_TYPES[opts.intent as keyof typeof REPLY_TYPES] ?? opts.intent}"` });
      done.push(`set ${a.setColumn} = "${a.setValue}"`);
    }

    if (a.addTag) {
      await tagConversation(conversation.id, conversation.workspaceId, a.addTag);
      done.push(`tagged "${a.addTag}"`);
    }

    if (a.assignTo) {
      const user = await prisma.user.findFirst({ where: { id: a.assignTo, organizationId: conversation.organizationId, status: 'ACTIVE' }, select: { id: true } });
      if (user && user.id !== conversation.assigneeId) {
        await prisma.conversation.update({ where: { id: conversation.id }, data: { assigneeId: user.id } });
        const actor: AppSession = {
          userId: conversation.ownerId, organizationId: conversation.organizationId, workspaceId: conversation.workspaceId, homeWorkspaceId: conversation.workspaceId,
          role: Role.OPERATOR, status: 'ACTIVE', email: '', name: ACTOR,
        };
        await notifyAssignment(conversation.id, user.id, actor).catch(() => undefined);
        done.push('assigned');
      }
    }

    if (a.stopFollowUps) {
      await prisma.$transaction([
        prisma.followUp.updateMany({ where: { conversationId: conversation.id, completed: false }, data: { completed: true } }),
        prisma.scheduledReply.updateMany({ where: { conversationId: conversation.id, status: 'PENDING' }, data: { status: 'CANCELLED', errorMessage: `Cancelled by ${ACTOR}` } }),
        ...(job.recordId ? [prisma.record.update({ where: { id: job.recordId }, data: { followUpRequired: false } })] : []),
      ]);
      done.push('stopped follow-ups');
    }

    if (a.unsubscribe && conversation.recipientEmail) {
      await prisma.emailSuppression.upsert({
        where: { workspaceId_email: { workspaceId: conversation.workspaceId, email: conversation.recipientEmail.toLowerCase() } },
        create: { workspaceId: conversation.workspaceId, email: conversation.recipientEmail.toLowerCase(), reason: 'UNSUBSCRIBED', source: 'UNSUBSCRIBE', detail: `${ACTOR}: asked to be left out`, campaignId: job.campaign.id },
        update: {},
      });
      done.push('added to the do-not-email list');
    }

    if (a.replyTemplateId) {
      const version = await prisma.templateVersion.findFirst({ where: { templateId: a.replyTemplateId }, orderBy: { version: 'desc' } });
      if (version) {
        const out = renderTemplate({ subject: version.subject, html: version.html, plainText: version.plainText }, (job.record?.data ?? {}) as Record<string, unknown>);
        const html = version.css ? `<style>${version.css}</style>${out.html}` : out.html;
        const auto = a.replyMode === 'auto' && out.missingVariables.length === 0;
        // The rule's template replaces a generic AI draft triage may have left a moment ago.
        await prisma.scheduledReply.updateMany({
          where: { conversationId: conversation.id, status: AI_DRAFT_STATUS },
          data: { status: 'CANCELLED', errorMessage: `Replaced by ${ACTOR}` },
        });
        await prisma.scheduledReply.create({
          data: {
            conversationId: conversation.id,
            workspaceId: conversation.workspaceId,
            createdById: job.campaign.createdById,
            scheduledFor: new Date(),
            html,
            plainText: out.plainText || htmlToPlainText(html),
            cc: [],
            newThread: false,
            // A draft waits in the Inbox for "Approve & send"; auto goes out straight away.
            status: auto ? 'PENDING' : AI_DRAFT_STATUS,
          },
        });
        if (auto) kickScheduledReplies();
        done.push(auto ? 'replied with a template' : a.replyMode === 'auto' ? 'drafted a template reply (some fields were empty, so it waits for approval)' : 'drafted a template reply for approval');
      }
    }

    if (a.setStatus && conversation.status !== a.setStatus) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: a.setStatus as ConversationStatus, ...(a.setStatus === 'RESOLVED' ? { unread: false } : {}) },
      });
      done.push(`status → ${a.setStatus.replace(/_/g, ' ').toLowerCase()}`);
    }

    if (a.notifyOwner) {
      await prisma.notification
        .create({
          data: {
            workspaceId: conversation.workspaceId,
            userId: job.campaign.createdById,
            type: 'REPLY_RULE',
            title: `${conversation.recipientEmail}: ${REPLY_TYPES[opts.intent as keyof typeof REPLY_TYPES] ?? opts.intent}`,
            body: `${job.campaign.name} — ${done.join(', ') || 'no automatic changes'}`,
            link: `/inbox/${conversation.id}`,
          },
        })
        .catch(() => undefined);
    }

    if (done.length) {
      await prisma.internalNote.create({
        data: {
          conversationId: conversation.id,
          authorId: conversation.ownerId,
          body: `${ACTOR} (${job.campaign.name}): the reply reads as "${REPLY_TYPES[opts.intent as keyof typeof REPLY_TYPES] ?? opts.intent}" (${Math.round(opts.confidence * 100)}% sure), so MailFlow ${done.join(', ')}.`,
        },
      });
      await prisma.auditLog.create({
        data: { organizationId: conversation.organizationId, actorId: null, action: 'REPLY_RULE_APPLIED', targetType: 'Conversation', targetId: conversation.id, metadata: { campaignId: job.campaign.id, rule: rule.id, intent: opts.intent, confidence: opts.confidence, done } },
      });
    }
    return rule;
  } catch (err) {
    console.error('[reply rules] failed (ignored)', err);
    return null;
  }
}
