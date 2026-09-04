import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadAutomationForSession } from '@/lib/automation/access';
import { previewImpact } from '@/lib/automation/runner';

/**
 * §74 automation safety.
 *
 * GET  → "Automation Ready — potential records: N" preview.
 * POST → actually flips enabled, and REQUIRES the caller to have seen the
 *        preview (it must echo back the record count it was shown). That
 *        makes it impossible to switch on mass email without the count
 *        having been displayed — "Never silently activate mass email".
 */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const automation = await loadAutomationForSession(session, params.id);
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const version = automation.versions[0];
  if (!version) return NextResponse.json({ error: 'Automation has no versions' }, { status: 400 });

  const impact = await previewImpact(version, automation.datasetId);
  const actions = Array.isArray(version.actions) ? (version.actions as any[]) : [];

  return NextResponse.json({
    automationName: automation.name,
    enabled: automation.enabled,
    ...impact,
    actions: actions.map((a) => a.type),
    willSendEmail: actions.some((a) => a.type === 'SEND_EMAIL'),
    version: version.version,
  });
});

const enableSchema = z.object({
  enabled: z.boolean(),
  /**
   * The record count the user was shown. Required when enabling, so the
   * confirmation cannot be bypassed by calling the API directly.
   */
  acknowledgedRecordCount: z.number().int().min(0).optional(),
});

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const automation = await loadAutomationForSession(session, params.id);
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = enableSchema.parse(await req.json());

  // Disabling is always allowed and never needs confirmation — stopping is
  // the safe direction.
  if (!body.enabled) {
    const updated = await prisma.automation.update({ where: { id: automation.id }, data: { enabled: false } });
    await audit(session, 'AUTOMATION_DISABLE', { targetType: 'Automation', targetId: automation.id });
    return NextResponse.json({ automation: updated });
  }

  const version = automation.versions[0];
  if (!version) return NextResponse.json({ error: 'Automation has no versions' }, { status: 400 });

  const actions = Array.isArray(version.actions) ? (version.actions as any[]) : [];
  if (actions.length === 0) {
    return NextResponse.json({ error: 'Add at least one action before enabling.' }, { status: 400 });
  }

  const impact = await previewImpact(version, automation.datasetId);

  if (body.acknowledgedRecordCount === undefined) {
    return NextResponse.json(
      {
        error: 'Confirmation required before enabling.',
        requiresConfirmation: true,
        ...impact,
        message: `This automation would act on ${impact.potentialRecords} of ${impact.totalRecords} records. Re-send with acknowledgedRecordCount to confirm.`,
      },
      { status: 409 }
    );
  }

  // If the dataset changed since the preview was shown, refuse: the number
  // the human approved is no longer the number that would be emailed.
  if (body.acknowledgedRecordCount !== impact.potentialRecords) {
    return NextResponse.json(
      {
        error: `The number of affected records changed (you saw ${body.acknowledgedRecordCount}, it is now ${impact.potentialRecords}). Review again before enabling.`,
        requiresConfirmation: true,
        ...impact,
      },
      { status: 409 }
    );
  }

  const updated = await prisma.automation.update({ where: { id: automation.id }, data: { enabled: true } });

  await audit(session, 'AUTOMATION_ENABLE', {
    targetType: 'Automation',
    targetId: automation.id,
    metadata: {
      potentialRecords: impact.potentialRecords,
      totalRecords: impact.totalRecords,
      condition: impact.conditionText,
      actions: actions.map((a) => a.type),
    },
  });

  return NextResponse.json({ automation: updated, ...impact });
});
