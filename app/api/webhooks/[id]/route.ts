import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';

const ALLOWED_EVENTS = [
  'conversation.created',
  'conversation.resolved',
  'conversation.message.received',
  'email.bounced',
  'email.unsubscribed',
];

const patchSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), { message: 'URL must start with https://' })
    .optional(),
  events: z
    .array(z.string())
    .min(1)
    .refine((arr) => arr.every((e) => ALLOWED_EVENTS.includes(e)), {
      message: `Events must be one of: ${ALLOWED_EVENTS.join(', ')}`,
    })
    .optional(),
  description: z.string().max(500).nullable().optional(),
  active: z.boolean().optional(),
});

async function loadEndpoint(id: string, workspaceId: string | null) {
  if (!workspaceId) return null;
  return prisma.webhookEndpoint.findFirst({ where: { id, workspaceId } });
}

/** GET /api/webhooks/[id] — single endpoint with recent deliveries. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const endpoint = await loadEndpoint(params.id, session.workspaceId);
  if (!endpoint) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const deliveries = await prisma.webhookDelivery.findMany({
    where: { endpointId: endpoint.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      event: true,
      status: true,
      statusCode: true,
      responseBody: true,
      attemptCount: true,
      lastAttemptAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    endpoint: {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      active: endpoint.active,
      description: endpoint.description,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      // Show only first 8 chars of secret; full secret is only revealed once at creation.
      secretHint: endpoint.secret.slice(0, 8) + '...',
    },
    deliveries,
  });
});

/** PATCH /api/webhooks/[id] — update url, events, description, active. */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const endpoint = await loadEndpoint(params.id, session.workspaceId);
  if (!endpoint) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = patchSchema.parse(await req.json());
  const updated = await prisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: {
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.events !== undefined ? { events: body.events } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    },
  });

  return NextResponse.json({
    endpoint: {
      id: updated.id,
      url: updated.url,
      events: updated.events,
      active: updated.active,
      description: updated.description,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
  });
});

/** DELETE /api/webhooks/[id] — remove the endpoint. */
export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const endpoint = await loadEndpoint(params.id, session.workspaceId);
  if (!endpoint) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
  return NextResponse.json({ deleted: true });
});
