import { prisma } from '@/lib/db/client';
import { EmailJobStatus, MessageDirection, MessageClassification } from '@prisma/client';
import { firstName, minimiseConversation } from '@/lib/ai/prompts';
import { runAiFeature, type AiContext } from '@/lib/ai/service';
import type { CampaignDigestInput, ConversationContext } from '@/lib/ai/types';

/**
 * Turns database rows into the minimal, redacted inputs the provider
 * receives (§81). Access checks happen in the route BEFORE these run —
 * every loader here takes an id that the caller has already verified is
 * inside the session's workspace/organisation.
 */

export async function loadConversationContext(conversationId: string, opts: { maxMessages?: number } = {}): Promise<ConversationContext | null> {
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      subject: true,
      contact: { select: { name: true } },
      account: { select: { user: { select: { name: true } } } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { direction: true, sentAt: true, receivedAt: true, createdAt: true, plainTextBody: true, htmlBody: true, snippet: true },
      },
    },
  });
  if (!c) return null;
  return {
    recipientFirstName: firstName(c.contact.name),
    senderName: c.account.user.name,
    subject: c.subject,
    messages: minimiseConversation(
      c.messages.map((m) => ({
        direction: m.direction,
        at: m.sentAt ?? m.receivedAt ?? m.createdAt,
        plainText: m.plainTextBody,
        html: m.htmlBody,
        snippet: m.snippet,
      })),
      { maxMessages: opts.maxMessages ?? 8 }
    ),
  };
}

export async function loadCampaignDigest(campaignId: string): Promise<CampaignDigestInput | null> {
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { name: true, status: true, workspaceId: true } });
  if (!c) return null;
  const [byStatus, errors, skips, replies] = await Promise.all([
    prisma.emailJob.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } }),
    prisma.emailJob.groupBy({
      by: ['errorMessage'],
      where: { campaignId, status: EmailJobStatus.FAILED, errorMessage: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { errorMessage: 'desc' } },
      take: 5,
    }),
    prisma.emailJob.groupBy({
      by: ['skipReason'],
      where: { campaignId, status: EmailJobStatus.SKIPPED, skipReason: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { skipReason: 'desc' } },
      take: 5,
    }),
    // Replies on threads this campaign started.
    prisma.conversationMessage.count({
      where: {
        direction: MessageDirection.INBOUND,
        classification: MessageClassification.HUMAN_REPLY,
        conversation: { workspaceId: c.workspaceId, gmailThreadId: { in: await campaignThreadIds(campaignId) } },
      },
    }),
  ]);
  const count = (s: EmailJobStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const sent = count(EmailJobStatus.SENT);
  const failed = count(EmailJobStatus.FAILED);
  const skipped = count(EmailJobStatus.SKIPPED);
  const pending = count(EmailJobStatus.QUEUED) + count(EmailJobStatus.SENDING);
  return {
    name: c.name,
    status: c.status,
    total: byStatus.reduce((a, b) => a + b._count._all, 0),
    sent,
    failed,
    skipped,
    pending,
    replies,
    topErrors: errors.map((e) => ({ message: (e.errorMessage ?? '').slice(0, 160), count: e._count._all })),
    topSkipReasons: skips.map((s) => ({ reason: (s.skipReason ?? '').slice(0, 160), count: s._count._all })),
  };
}

async function campaignThreadIds(campaignId: string): Promise<string[]> {
  const jobs = await prisma.emailJob.findMany({
    where: { campaignId, gmailThreadId: { not: null } },
    select: { gmailThreadId: true },
    take: 5000,
  });
  return jobs.map((j) => j.gmailThreadId as string);
}

/** Facts for "why was this email sent?" — the immutable job snapshot plus its recorded reason (§89/§126). */
export async function explainSendFacts(emailJobId: string) {
  const job = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    select: {
      status: true,
      sendReason: true,
      skipReason: true,
      errorCode: true,
      errorMessage: true,
      retryCount: true,
      sentAt: true,
      lastAttemptAt: true,
      subject: true,
      campaign: { select: { name: true, status: true, automation: { select: { name: true } } } },
      batch: { select: { label: true, status: true } },
      templateVersion: { select: { version: true } },
    },
  });
  if (!job) return null;
  return {
    campaign: job.campaign.name,
    campaignStatus: job.campaign.status,
    automation: job.campaign.automation?.name ?? null,
    batch: job.batch.label,
    batchStatus: job.batch.status,
    templateVersion: job.templateVersion.version,
    subject: job.subject,
    jobStatus: job.status,
    sendReason: job.sendReason,
    skipReason: job.skipReason,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage?.slice(0, 300) ?? null,
    retryCount: job.retryCount,
    sentAt: job.sentAt,
    lastAttemptAt: job.lastAttemptAt,
  };
}

/** Facts for "why did this automation run fail / skip?" (§76 item 19). */
export async function explainAutomationFacts(runId: string) {
  const run = await prisma.automationRun.findUnique({
    where: { id: runId },
    select: {
      triggerType: true,
      conditionsMet: true,
      actionTaken: true,
      result: true,
      error: true,
      createdAt: true,
      automation: { select: { name: true, enabled: true } },
      automationVersion: { select: { version: true } },
    },
  });
  if (!run) return null;
  return {
    automation: run.automation.name,
    automationEnabled: run.automation.enabled,
    version: run.automationVersion.version,
    triggerType: run.triggerType,
    conditionsMet: run.conditionsMet,
    actionTaken: run.actionTaken,
    result: run.result,
    error: run.error?.slice(0, 500) ?? null,
    at: run.createdAt,
  };
}

/**
 * §80 — after ingest stores a human reply, ask the AI for a finer intent and
 * store it BESIDE the header-first classification. Never throws, never
 * changes the classification, status, or any record: it only annotates.
 */
export async function classifyStoredMessage(messageId: string, ctx: AiContext, opts: { timeoutMs?: number } = {}): Promise<void> {
  try {
    const msg = await prisma.conversationMessage.findUnique({ where: { id: messageId }, select: { conversationId: true, aiIntent: true } });
    if (!msg || msg.aiIntent) return;
    const context = await loadConversationContext(msg.conversationId, { maxMessages: 6 });
    if (!context || context.messages.length === 0) return;

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 12_000));
    const outcome = await Promise.race([runAiFeature(ctx, 'classify_reply', (p) => p.classifyReply(context)), timeout]);
    if (!outcome || !outcome.ok) return;

    await prisma.conversationMessage.update({
      where: { id: messageId },
      data: {
        aiIntent: outcome.data.intent,
        aiIntentConfidence: outcome.data.confidence,
        aiIntentReason: outcome.data.reason.slice(0, 300),
      },
    });
  } catch (err) {
    console.error('[ai] classifyStoredMessage failed (ignored)', err);
  }
}
