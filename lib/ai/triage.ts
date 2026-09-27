import { prisma } from '@/lib/db/client';
import { ConversationStatus, Role } from '@prisma/client';
import type { AppSession } from '@/lib/auth/session';
import { runAiFeature, type AiContext } from '@/lib/ai/service';
import { loadConversationContext } from '@/lib/ai/context';
import { notifyAssignment } from '@/lib/conversations/notify';
import { INTENT_TAGS, type OrgSettings, type TriageIntent } from '@/lib/settings/org-schema';
import { getOrgSettings } from '@/lib/settings/org';

/**
 * AI inbox triage, run after a human reply is stored and its intent is known:
 * tag by intent, assign unassigned conversations, close plain "thank you"
 * replies, and leave a draft answer for questions and requests. Everything is
 * best-effort and switchable per organisation (Admin → System settings).
 */

export const DRAFT_INTENTS = new Set(['QUESTION', 'REQUEST', 'COMPLAINT', 'NEEDS_ACTION']);
export const AI_DRAFT_STATUS = 'DRAFT';
export const TRIAGE_ACTOR_NAME = 'MailFlow AI';

export interface TriageInput {
  intent: string;
  confidence: number;
  assigneeId: string | null;
  ownerId: string;
  status: ConversationStatus;
  /** The team has written in this thread before (so "thanks" is closing a loop). */
  hasOutbound: boolean;
}

export interface TriageDecision {
  tag: string | null;
  assignTo: string | null;
  resolve: boolean;
  draft: boolean;
}

export function decideTriage(settings: OrgSettings['triage'], input: TriageInput): TriageDecision {
  const none: TriageDecision = { tag: null, assignTo: null, resolve: false, draft: false };
  if (!settings.enabled) return none;
  const intent = input.intent as TriageIntent;
  const known = Object.prototype.hasOwnProperty.call(INTENT_TAGS, intent);

  const resolve =
    settings.autoResolveAcknowledgements &&
    intent === 'ACKNOWLEDGEMENT' &&
    input.confidence >= settings.autoResolveMinConfidence &&
    input.hasOutbound &&
    input.status !== ConversationStatus.RESOLVED &&
    input.status !== ConversationStatus.CLOSED;

  let assignTo: string | null = null;
  // A conversation being closed needs nobody; one someone already owns stays theirs.
  if (settings.autoAssign && !input.assigneeId && known && !resolve) {
    assignTo = settings.assignByIntent[intent] || input.ownerId;
  }

  return {
    tag: settings.autoTag && known ? INTENT_TAGS[intent] : null,
    assignTo,
    resolve,
    draft: settings.draftReplies && DRAFT_INTENTS.has(intent),
  };
}

/** Plain-text draft to the simple HTML the reply composer sends. */
export function draftToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

async function tagConversation(conversationId: string, workspaceId: string, name: string) {
  const tag = await prisma.tag.upsert({
    where: { workspaceId_name: { workspaceId, name } },
    create: { workspaceId, name },
    update: {},
  });
  await prisma.conversationTag.upsert({
    where: { conversationId_tagId: { conversationId, tagId: tag.id } },
    create: { conversationId, tagId: tag.id },
    update: {},
  });
}

export async function triageReply(opts: {
  messageId: string;
  conversationId: string;
  intent: string;
  confidence: number;
  ai: AiContext;
  mailboxEmail: string;
}): Promise<TriageDecision | null> {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: opts.conversationId },
      select: { id: true, organizationId: true, workspaceId: true, ownerId: true, assigneeId: true, status: true, contactId: true },
    });
    if (!conversation) return null;
    const settings = await getOrgSettings(conversation.organizationId);
    const hasOutbound = (await prisma.conversationMessage.count({ where: { conversationId: conversation.id, direction: 'OUTBOUND' } })) > 0;
    const decision = decideTriage(settings.triage, {
      intent: opts.intent,
      confidence: opts.confidence,
      assigneeId: conversation.assigneeId,
      ownerId: conversation.ownerId,
      status: conversation.status,
      hasOutbound,
    });

    if (decision.tag) await tagConversation(conversation.id, conversation.workspaceId, decision.tag).catch((e) => console.error('[triage] tag failed', e));

    if (decision.assignTo) {
      const assignee = await prisma.user.findFirst({
        where: { id: decision.assignTo, organizationId: conversation.organizationId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (assignee) {
        // Only if still unassigned: a person may have picked it up meanwhile.
        const res = await prisma.conversation.updateMany({ where: { id: conversation.id, assigneeId: null }, data: { assigneeId: assignee.id } });
        if (res.count && assignee.id !== conversation.ownerId) {
          const actor: AppSession = {
            userId: conversation.ownerId,
            organizationId: conversation.organizationId,
            workspaceId: conversation.workspaceId,
            homeWorkspaceId: conversation.workspaceId,
            role: Role.OPERATOR,
            status: 'ACTIVE',
            // The mailbox address: the notification then CCs nobody extra.
            email: opts.mailboxEmail,
            name: TRIAGE_ACTOR_NAME,
          };
          await notifyAssignment(conversation.id, assignee.id, actor).catch((e) => console.error('[triage] notify failed', e));
        }
        if (res.count) {
          await prisma.auditLog.create({
            data: {
              organizationId: conversation.organizationId,
              actorId: null,
              action: 'CONVERSATION_ASSIGN',
              targetType: 'Conversation',
              targetId: conversation.id,
              metadata: { from: null, to: assignee.id, by: 'ai_triage', intent: opts.intent },
            },
          });
        }
      }
    }

    if (decision.resolve) {
      await prisma.$transaction([
        prisma.conversation.update({ where: { id: conversation.id }, data: { status: ConversationStatus.RESOLVED, unread: false } }),
        prisma.internalNote.create({
          data: {
            conversationId: conversation.id,
            authorId: conversation.ownerId,
            body: `${TRIAGE_ACTOR_NAME} marked this resolved: the latest reply reads as a thank-you (confidence ${Math.round(opts.confidence * 100)}%). Reopen it if something is still needed.`,
          },
        }),
        prisma.recipientHistory.create({
          data: { contactId: conversation.contactId, type: 'STATUS_CHANGE', summary: `Conversation auto-resolved by ${TRIAGE_ACTOR_NAME} (thank-you reply)`, refId: conversation.id },
        }),
        prisma.auditLog.create({
          data: {
            organizationId: conversation.organizationId,
            actorId: null,
            action: 'CONVERSATION_STATUS_CHANGE',
            targetType: 'Conversation',
            targetId: conversation.id,
            metadata: { from: conversation.status, to: 'RESOLVED', by: 'ai_triage', intent: opts.intent, confidence: opts.confidence },
          },
        }),
      ]);
    }

    if (decision.draft) await createDraft(conversation.id, conversation.workspaceId, conversation.ownerId, opts.ai);

    return decision;
  } catch (err) {
    console.error('[triage] failed (ignored)', err);
    return null;
  }
}

/** Replaces any earlier AI draft on the conversation with one for the latest reply. */
async function createDraft(conversationId: string, workspaceId: string, ownerId: string, ai: AiContext, timeoutMs = 15_000) {
  const context = await loadConversationContext(conversationId, { maxMessages: 8 });
  if (!context || context.messages.length === 0) return;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const outcome = await Promise.race([runAiFeature(ai, 'suggest_reply', (p) => p.suggestReply(context)), timeout]);
  if (!outcome || !outcome.ok || !outcome.data.text.trim()) return;
  await prisma.$transaction([
    prisma.scheduledReply.updateMany({ where: { conversationId, status: AI_DRAFT_STATUS }, data: { status: 'CANCELLED', errorMessage: 'Replaced by a newer AI draft' } }),
    prisma.scheduledReply.create({
      data: {
        conversationId,
        workspaceId,
        createdById: ownerId,
        scheduledFor: new Date(),
        html: draftToHtml(outcome.data.text),
        plainText: outcome.data.text.trim(),
        cc: [],
        status: AI_DRAFT_STATUS,
      },
    }),
  ]);
}
