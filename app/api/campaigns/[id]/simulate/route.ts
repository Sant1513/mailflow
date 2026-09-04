import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { canWrite } from '@/lib/permissions/workspace';
import { loadCampaignForSession, buildEvaluationContext, senderAccountFor, emailColumnKeyOf } from '@/lib/campaigns/context';
import { dryRun, validateCampaign } from '@/lib/campaigns/evaluate';
import { audit } from '@/lib/audit/log';

/**
 * §34 Run Simulation — evaluates every record and reports exactly what would
 * happen. NO EMAILS ARE SENT: this route never writes an EmailJob, never
 * touches a provider, and shares its logic with the real send so the
 * prediction is trustworthy.
 */
export const POST = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const campaign = await loadCampaignForSession(session, params.id);
  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sender = await senderAccountFor(campaign);
  const built = await buildEvaluationContext(campaign, { senderEmail: sender?.emailAddress });
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 });

  const simulation = dryRun(built.records, built.ctx);

  const validation = validateCampaign({
    hasDataset: true,
    hasTemplate: true,
    hasEmailColumn: !!emailColumnKeyOf(campaign.dataset),
    senderConnected: !!sender && sender.status === 'CONNECTED',
    senderStatus: sender?.status,
    template: {
      subject: campaign.templateVersion.subject,
      html: campaign.templateVersion.html,
      plainText: campaign.templateVersion.plainText,
    },
    availableColumnKeys: campaign.dataset.columns.map((c) => c.key),
    recipientCount: simulation.wouldSend,
    canSend: canWrite(session.role),
  });

  await audit(session, 'CAMPAIGN_SIMULATE', {
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: { wouldSend: simulation.wouldSend, skipped: simulation.skipped },
  });

  return NextResponse.json({
    simulation: {
      total: simulation.total,
      wouldSend: simulation.wouldSend,
      skipped: simulation.skipped,
      invalid: simulation.invalid,
      byReason: simulation.byReason,
      // Every record, with its exact reason (§34) — capped so a huge
      // dataset doesn't produce an unusable response.
      evaluations: simulation.evaluations.slice(0, 500),
      truncated: simulation.evaluations.length > 500,
    },
    validation,
    sender: sender ? { emailAddress: sender.emailAddress, status: sender.status } : null,
    templateVersion: campaign.templateVersion.version,
    emailsSent: 0,
  });
});
