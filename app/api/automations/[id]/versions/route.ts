import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadAutomationForSession } from '../route';

const ruleSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({
      field: z.string().min(1),
      operator: z.enum([
        'equals', 'not_equals', 'contains', 'not_contains',
        'greater_than', 'less_than', 'is_empty', 'is_not_empty',
      ]),
      value: z.any().optional(),
    }),
    z.object({ op: z.enum(['AND', 'OR']), rules: z.array(ruleSchema) }),
  ])
);
const conditionGroupSchema = z.object({ op: z.enum(['AND', 'OR']), rules: z.array(ruleSchema) });

const versionSchema = z.object({
  triggerType: z.enum(['RECORD_MATCHES_CONDITIONS', 'RECORD_CREATED', 'RECORD_UPDATED', 'MANUAL', 'SCHEDULED']),
  triggerConfig: z.record(z.any()).default({}),
  conditions: conditionGroupSchema,
  actions: z.array(z.object({ type: z.enum(['SEND_EMAIL', 'UPDATE_RECORD', 'WAIT', 'NOTIFY_USER']), config: z.record(z.any()).default({}) })),
  stopConditions: conditionGroupSchema.nullable().optional(),
  frequencyPolicy: z.object({
    mode: z.enum(['ONCE', 'ONCE_PER_DAY', 'ONCE_PER_WEEK', 'ONCE_PER_CAMPAIGN', 'ALLOW_REPEATED']),
    cooldownDays: z.number().int().min(0).max(365).optional(),
  }),
});

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const automation = await loadAutomationForSession(session, params.id);
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ versions: automation.versions });
});

/**
 * §73 automation versioning: editing creates a new immutable version, so a
 * batch sent last week still records the exact configuration that sent it.
 * Changing configuration also disables the automation — the operator must
 * re-confirm the impact of the NEW rules before it can fire again (§74).
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const automation = await loadAutomationForSession(session, params.id);
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = versionSchema.parse(await req.json());
  const latest = automation.versions[0];

  const version = await prisma.automationVersion.create({
    data: {
      automationId: automation.id,
      version: (latest?.version ?? 0) + 1,
      triggerType: body.triggerType,
      triggerConfig: body.triggerConfig,
      conditions: body.conditions,
      actions: body.actions,
      stopConditions: body.stopConditions ?? undefined,
      frequencyPolicy: body.frequencyPolicy,
      createdById: session.userId,
    },
  });

  const wasEnabled = automation.enabled;
  await prisma.automation.update({
    where: { id: automation.id },
    data: { enabled: false, updatedAt: new Date() },
  });

  await audit(session, 'AUTOMATION_VERSION_CREATE', {
    targetType: 'AutomationVersion',
    targetId: version.id,
    metadata: { automationId: automation.id, version: version.version, disabledForReview: wasEnabled },
  });

  return NextResponse.json(
    {
      version,
      disabled: wasEnabled,
      message: wasEnabled
        ? 'Saved as a new version. The automation was turned off — review the new rules and enable it again.'
        : 'Saved as a new version.',
    },
    { status: 201 }
  );
});
