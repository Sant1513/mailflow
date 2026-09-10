import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, type AppSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';
import { aiStatus, runAiFeature, usageToday, type AiContext } from '@/lib/ai/service';
import { explainAutomationFacts, explainSendFacts, loadCampaignDigest, loadConversationContext } from '@/lib/ai/context';
import { IMPROVE_MODES } from '@/lib/ai/types';
import { extractVariables } from '@/lib/templates/variables';

/**
 * §76 AI features behind one endpoint. Every action:
 *  - derives identity from the session (never the body),
 *  - checks the target row is inside the caller's workspace,
 *  - runs through runAiFeature (enabled? configured? limits? logged),
 *  - returns 200 with { ok:false, code, message } when the AI is unavailable,
 *    so the UI degrades to "continue manually" instead of erroring (§82).
 * Nothing here sends email or changes a record: all output is a suggestion
 * the human inserts, edits or discards (§77–§80).
 */

const variables = z.array(z.string().min(1).max(64)).max(100).default([]);

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('generate_email'),
    brief: z.string().min(3).max(2000),
    tone: z.enum(['professional', 'friendly', 'urgent', 'neutral']).optional(),
    variables,
  }),
  z.object({
    action: z.literal('improve_text'),
    text: z.string().min(1).max(20_000),
    mode: z.enum(IMPROVE_MODES as [string, ...string[]]),
    format: z.enum(['html', 'text']).default('text'),
    language: z.string().max(40).optional(),
    variables,
  }),
  z.object({
    action: z.literal('subject_lines'),
    brief: z.string().min(3).max(2000),
    body: z.string().max(20_000).optional(),
    variables,
    count: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    action: z.literal('check_personalization'),
    subject: z.string().max(500),
    body: z.string().min(1).max(20_000),
    variables,
  }),
  z.object({
    action: z.literal('suggest_reply'),
    conversationId: z.string().min(1),
    style: z.enum(['default', 'shorter', 'formal']).default('default'),
  }),
  z.object({ action: z.literal('summarize_conversation'), conversationId: z.string().min(1) }),
  z.object({ action: z.literal('classify_reply'), conversationId: z.string().min(1) }),
  z.object({ action: z.literal('summarize_campaign'), campaignId: z.string().min(1) }),
  z.object({ action: z.literal('explain_send'), emailJobId: z.string().min(1) }),
  z.object({ action: z.literal('explain_automation'), runId: z.string().min(1) }),
]);

function ctxOf(session: AppSession, workspaceId: string): AiContext {
  return { userId: session.userId, organizationId: session.organizationId, workspaceId };
}

/** Conversation must be in the caller's workspace. */
async function conversationInWorkspace(id: string, workspaceId: string) {
  return prisma.conversation.findFirst({ where: { id, workspaceId }, select: { id: true } });
}

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  const body = actionSchema.parse(await req.json());
  const workspaceId = await resolveWorkspaceId(session);
  const ctx = ctxOf(session, workspaceId);
  const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

  switch (body.action) {
    case 'generate_email': {
      const outcome = await runAiFeature(ctx, 'generate_email', (p) =>
        p.generateEmail({ brief: body.brief, tone: body.tone, variables: body.variables, senderName: session.name, orgName: 'Masai School' })
      );
      return NextResponse.json(outcome);
    }
    case 'improve_text': {
      const outcome = await runAiFeature(ctx, 'improve_text', (p) =>
        p.improveText({ text: body.text, mode: body.mode as any, format: body.format, language: body.language, variables: body.variables })
      );
      return NextResponse.json(outcome);
    }
    case 'subject_lines': {
      const outcome = await runAiFeature(ctx, 'subject_lines', (p) =>
        p.subjectLines({ brief: body.brief, body: body.body, variables: body.variables, count: body.count })
      );
      return NextResponse.json(outcome);
    }
    case 'check_personalization': {
      // Missing variables are a fact, computed locally; the AI only judges quality.
      const used = extractVariables(body.subject, body.body);
      const missing = used.filter((v) => !body.variables.includes(v));
      const outcome = await runAiFeature(ctx, 'check_personalization', (p) =>
        p.checkPersonalization({ subject: body.subject, body: body.body, availableVariables: body.variables, usedVariables: used })
      );
      return NextResponse.json(outcome.ok ? { ...outcome, data: { ...outcome.data, usedVariables: used, missingVariables: missing } } : { ...outcome, missingVariables: missing });
    }
    case 'suggest_reply':
    case 'summarize_conversation':
    case 'classify_reply': {
      if (!(await conversationInWorkspace(body.conversationId, workspaceId))) return notFound();
      const context = await loadConversationContext(body.conversationId);
      if (!context || context.messages.length === 0) {
        return NextResponse.json({ ok: false, code: 'ERROR', message: 'This conversation has no messages to work from.' });
      }
      if (body.action === 'suggest_reply') {
        return NextResponse.json(await runAiFeature(ctx, 'suggest_reply', (p) => p.suggestReply(context, body.style)));
      }
      if (body.action === 'summarize_conversation') {
        return NextResponse.json(await runAiFeature(ctx, 'summarize_conversation', (p) => p.summarizeConversation(context)));
      }
      const outcome = await runAiFeature(ctx, 'classify_reply', (p) => p.classifyReply(context));
      if (outcome.ok && !session.viewingAs) {
        // Annotate the latest inbound message; the header-first classification is untouched (§80).
        // Skipped under "view as" (§9): inspection writes nothing.
        const latest = await prisma.conversationMessage.findFirst({
          where: { conversationId: body.conversationId, direction: 'INBOUND' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (latest) {
          await prisma.conversationMessage.update({
            where: { id: latest.id },
            data: { aiIntent: outcome.data.intent, aiIntentConfidence: outcome.data.confidence, aiIntentReason: outcome.data.reason.slice(0, 300) },
          });
        }
      }
      return NextResponse.json(outcome);
    }
    case 'summarize_campaign': {
      const campaign = await prisma.campaign.findFirst({ where: { id: body.campaignId, workspaceId }, select: { id: true } });
      if (!campaign) return notFound();
      const digest = await loadCampaignDigest(body.campaignId);
      if (!digest) return notFound();
      return NextResponse.json(await runAiFeature(ctx, 'summarize_campaign', (p) => p.summarizeCampaign(digest)));
    }
    case 'explain_send': {
      const job = await prisma.emailJob.findFirst({ where: { id: body.emailJobId, campaign: { workspaceId } }, select: { id: true } });
      if (!job) return notFound();
      const facts = await explainSendFacts(body.emailJobId);
      if (!facts) return notFound();
      return NextResponse.json(
        await runAiFeature(ctx, 'explain_send', (p) => p.explain('Why was this email sent (or not sent), and what happened to it?', facts))
      );
    }
    case 'explain_automation': {
      const run = await prisma.automationRun.findFirst({ where: { id: body.runId, automation: { workspaceId } }, select: { id: true } });
      if (!run) return notFound();
      const facts = await explainAutomationFacts(body.runId);
      if (!facts) return notFound();
      return NextResponse.json(
        await runAiFeature(ctx, 'explain_automation', (p) => p.explain('Why did this automation run end the way it did?', facts))
      );
    }
  }
});

/** §82 "AI usage today: 42 / 100" plus whether AI is on at all. */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const status = aiStatus();
  const counts = await usageToday(session);
  return NextResponse.json({
    enabled: status.enabled && status.configured,
    configured: status.configured,
    provider: status.provider,
    model: status.model,
    usage: {
      userToday: counts.userToday,
      userLimit: status.limits.userDaily,
      orgToday: counts.orgToday,
      orgLimit: status.limits.orgDaily,
    },
  });
});
