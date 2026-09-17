import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';

/** POST /api/webhooks/[id]/test — fire a ping event and return the delivery result. */
export const POST = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 });

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
  });
  if (!endpoint) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const timestamp = Date.now();
  const payload = {
    event: 'ping',
    timestamp,
    workspaceId: session.workspaceId,
    data: { message: 'This is a test delivery from MailFlow.' },
  };
  const bodyStr = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', endpoint.secret).update(bodyStr).digest('hex');

  let status: 'SUCCESS' | 'FAILED' = 'FAILED';
  let statusCode: number | null = null;
  let responseBody: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let res: Response;
    try {
      res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MailFlow-Event': 'ping',
          'X-MailFlow-Signature': signature,
          'X-MailFlow-Timestamp': String(timestamp),
        },
        body: bodyStr,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    statusCode = res.status;
    const text = await res.text().catch(() => '');
    responseBody = text.slice(0, 2000);
    status = res.ok ? 'SUCCESS' : 'FAILED';
  } catch {
    // Timeout or network error
  }

  const delivery = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      event: 'ping',
      payload,
      status,
      statusCode,
      responseBody,
      attemptCount: 1,
      lastAttemptAt: new Date(),
    },
  });

  return NextResponse.json({
    delivery: {
      id: delivery.id,
      event: delivery.event,
      status: delivery.status,
      statusCode: delivery.statusCode,
      responseBody: delivery.responseBody,
      createdAt: delivery.createdAt,
    },
  });
});
