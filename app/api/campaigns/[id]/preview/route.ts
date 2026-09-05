import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { canWrite } from '@/lib/permissions/workspace';
import {
  loadCampaignForSession,
  buildEvaluationContext,
  senderAccountFor,
  emailColumnKeyOf,
} from '@/lib/campaigns/context';
import { dryRun, validateCampaign } from '@/lib/campaigns/evaluate';
import { renderTemplate, validateVariables } from '@/lib/templates/variables';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { runHealthCheck } from '@/lib/templates/healthCheck';

/**
 * §113 campaign review: everything a human needs to cross-check BEFORE a
 * send — exactly who receives it, exactly what each of them will see, what
 * the sender headers will be, and what is wrong.
 *
 * Read-only. It creates no batch, no job, and sends nothing.
 */
const previewSchema = z.object({
  /** Render this specific recipient; defaults to the first sendable one. */
  recordId: z.string().optional(),
  /** How many recipient rows to list back. */
  limit: z.number().int().min(1).max(200).default(50),
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = previewSchema.parse(await req.json().catch(() => ({})));
  const sender = await senderAccountFor(campaign);
  const built = await buildEvaluationContext(campaign, { senderEmail: sender?.emailAddress });
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 });

  const simulation = dryRun(built.records, built.ctx);
  const version = campaign.templateVersion;
  const columnKeys = campaign.dataset.columns.map((c) => c.key);

  // Resolve the sender headers exactly as the send route will build them,
  // so the preview cannot drift from what actually goes out.
  const fromName = campaign.fromName?.trim() || sender?.displayName || campaign.createdBy.name;
  const fromEmail = sender?.emailAddress ?? null;

  // Which record to render.
  const firstSendable = simulation.evaluations.find((e) => e.willSend);
  const targetId = body.recordId ?? firstSendable?.recordId ?? built.records[0]?.id;
  const target = built.records.find((r) => r.id === targetId) ?? null;

  let rendered: {
    subject: string;
    html: string;
    plainText: string | null;
    missingVariables: string[];
    resolved: Record<string, string>;
  } | null = null;

  if (target) {
    const out = renderTemplate(
      { subject: version.subject, html: version.html, plainText: version.plainText },
      target.data
    );
    const withCss = version.css ? `<style>${version.css}</style>${out.html}` : out.html;
    rendered = {
      subject: out.subject,
      // Sanitized because the preview renders in the operator's browser.
      html: sanitizeEmailHtml(withCss),
      plainText: out.plainText,
      missingVariables: out.missingVariables,
      resolved: out.resolved,
    };
  }

  const variableCheck = validateVariables(
    { subject: version.subject, html: version.html, plainText: version.plainText },
    columnKeys
  );

  const health = runHealthCheck({
    template: { subject: version.subject, html: version.html, plainText: version.plainText },
    availableKeys: columnKeys,
    hasRecipientColumn: !!emailColumnKeyOf(campaign.dataset),
    senderConnected: !!sender && sender.status === 'CONNECTED',
    senderEmail: sender?.emailAddress ?? null,
  });

  const validation = validateCampaign({
    hasDataset: true,
    hasTemplate: true,
    hasEmailColumn: !!emailColumnKeyOf(campaign.dataset),
    senderConnected: !!sender && sender.status === 'CONNECTED',
    senderStatus: sender?.status,
    template: { subject: version.subject, html: version.html, plainText: version.plainText },
    availableColumnKeys: columnKeys,
    recipientCount: simulation.wouldSend,
    canSend: canWrite(session.role),
  });

  // Recipient table: who gets it, who doesn't, and why — with the data that
  // will be substituted, so the operator can spot bad rows before sending.
  const recipients = simulation.evaluations.slice(0, body.limit).map((e) => {
    const record = built.records.find((r) => r.id === e.recordId);
    return {
      recordId: e.recordId,
      email: e.email,
      willSend: e.willSend,
      skipReason: e.skipReason,
      reasonDetail: e.reasonDetail,
      data: record?.data ?? {},
    };
  });

  return NextResponse.json({
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      dataset: { id: campaign.dataset.id, name: campaign.dataset.name },
      template: { id: campaign.template.id, name: campaign.template.name },
      templateVersion: version.version,
      scheduledAt: campaign.scheduledAt,
      timezone: campaign.timezone,
    },
    // Exactly the headers the send will use.
    headers: {
      fromName,
      fromEmail,
      // Surfaced so it is obvious the From address cannot be changed.
      fromEmailLocked: true,
      replyTo: campaign.replyTo,
      cc: campaign.ccEmails,
      bcc: campaign.bccEmails,
      senderStatus: sender?.status ?? null,
    },
    summary: {
      total: simulation.total,
      wouldSend: simulation.wouldSend,
      skipped: simulation.skipped,
      invalid: simulation.invalid,
      byReason: simulation.byReason,
      // Cc/Bcc go on EVERY message, so make the real volume explicit —
      // 250 recipients with 2 people cc'd is 500 extra deliveries.
      ccPerMessage: campaign.ccEmails.length,
      bccPerMessage: campaign.bccEmails.length,
      totalDeliveries:
        simulation.wouldSend * (1 + campaign.ccEmails.length + campaign.bccEmails.length),
    },
    recipients,
    recipientsTruncated: simulation.evaluations.length > body.limit,
    preview: rendered
      ? { recordId: target!.id, ...rendered }
      : null,
    templateCheck: {
      variablesUsed: variableCheck.used,
      variablesMissing: variableCheck.missing,
      columnsUnused: variableCheck.unused,
      ok: variableCheck.ok,
    },
    health,
    validation,
    emailsSent: 0,
  });
});
