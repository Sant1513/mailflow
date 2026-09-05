import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId, requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));

  const automations = await prisma.automation.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: {
      versions: { orderBy: { version: 'desc' }, take: 1 },
      _count: { select: { runs: true, versions: true } },
    },
  });

  return NextResponse.json({ automations });
});

const ruleSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({
      field: z.string().min(1),
      operator: z.enum([
        'equals',
        'not_equals',
        'contains',
        'not_contains',
        'greater_than',
        'less_than',
        'is_empty',
        'is_not_empty',
      ]),
      value: z.any().optional(),
    }),
    z.object({ op: z.enum(['AND', 'OR']), rules: z.array(ruleSchema) }),
  ])
);

const conditionGroupSchema = z.object({ op: z.enum(['AND', 'OR']), rules: z.array(ruleSchema) });

const actionSchema = z.object({
  type: z.enum(['SEND_EMAIL', 'UPDATE_RECORD', 'WAIT', 'NOTIFY_USER']),
  config: z.record(z.any()).default({}),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  datasetId: z.string().nullable().optional(),
  triggerType: z
    .enum(['RECORD_MATCHES_CONDITIONS', 'RECORD_CREATED', 'RECORD_UPDATED', 'MANUAL', 'SCHEDULED'])
    .default('RECORD_MATCHES_CONDITIONS'),
  triggerConfig: z.record(z.any()).default({}),
  conditions: conditionGroupSchema.default({ op: 'AND', rules: [] }),
  actions: z.array(actionSchema).default([]),
  stopConditions: conditionGroupSchema.nullable().optional(),
  frequencyPolicy: z
    .object({
      mode: z.enum(['ONCE', 'ONCE_PER_DAY', 'ONCE_PER_WEEK', 'ONCE_PER_CAMPAIGN', 'ALLOW_REPEATED']),
      cooldownDays: z.number().int().min(0).max(365).optional(),
    })
    .default({ mode: 'ONCE' }),
  workspaceId: z.string().optional(),
});

/**
 * §68/§74: a new automation is always created DISABLED. Enabling it is a
 * separate, explicit step that shows how many records it would affect —
 * mass email is never switched on as a side effect of creation.
 */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  const body = createSchema.parse(await req.json());
  const workspaceId = await resolveWorkspaceId(session, body.workspaceId);

  if (body.datasetId) {
    const dataset = await prisma.dataset.findUnique({ where: { id: body.datasetId } });
    if (!dataset || dataset.workspaceId !== workspaceId) {
      return NextResponse.json({ error: 'Dataset not found in this workspace' }, { status: 404 });
    }
  }

  const automation = await prisma.automation.create({
    data: {
      organizationId: session.organizationId,
      workspaceId,
      datasetId: body.datasetId ?? null,
      name: body.name,
      enabled: false,
      versions: {
        create: {
          version: 1,
          triggerType: body.triggerType,
          triggerConfig: body.triggerConfig,
          conditions: body.conditions,
          actions: body.actions,
          stopConditions: body.stopConditions ?? undefined,
          frequencyPolicy: body.frequencyPolicy,
          createdById: session.userId,
        },
      },
    },
    include: { versions: true },
  });

  await audit(session, 'AUTOMATION_CREATE', { targetType: 'Automation', targetId: automation.id });

  return NextResponse.json({ automation }, { status: 201 });
});
