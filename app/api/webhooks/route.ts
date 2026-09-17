import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
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

const createSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), { message: 'URL must start with https://' }),
  events: z
    .array(z.string())
    .min(1, 'At least one event is required')
    .refine((arr) => arr.every((e) => ALLOWED_EVENTS.includes(e)), {
      message: `Events must be one of: ${ALLOWED_EVENTS.join(', ')}`,
    }),
  description: z.string().max(500).optional(),
});

/** GET /api/webhooks — list endpoints for the workspace (secret excluded). */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ endpoints: [] });

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { workspaceId: session.workspaceId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      url: true,
      events: true,
      active: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ endpoints });
});

/** POST /api/webhooks — create a new endpoint. Returns the secret once. */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 });

  const body = createSchema.parse(await req.json());
  const secret = crypto.randomBytes(32).toString('hex');

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      workspaceId: session.workspaceId,
      url: body.url,
      secret,
      events: body.events,
      description: body.description ?? null,
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
      secret, // returned only once at creation
    },
  });
});
