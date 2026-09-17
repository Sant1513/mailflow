import crypto from 'crypto';
import { prisma } from '@/lib/db/client';

/**
 * Dispatches a webhook event to all active endpoints registered for the
 * workspace that subscribe to this event. Fire-and-forget: never throws,
 * never blocks the caller. Each delivery is recorded in WebhookDelivery.
 *
 * Usage (always fire-and-forget — do not await):
 *   dispatchWebhook(workspaceId, 'conversation.resolved', { ... }).catch(() => undefined);
 */
export async function dispatchWebhook(
  workspaceId: string,
  event: string,
  data: object,
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { workspaceId, active: true, events: { has: event } },
  });

  if (endpoints.length === 0) return;

  const timestamp = Date.now();
  const payload = { event, timestamp, workspaceId, data };
  const bodyStr = JSON.stringify(payload);

  await Promise.allSettled(
    endpoints.map((ep) => sendToEndpoint(ep, event, payload, bodyStr, timestamp)),
  );
}

async function sendToEndpoint(
  ep: { id: string; url: string; secret: string },
  event: string,
  payload: object,
  bodyStr: string,
  timestamp: number,
): Promise<void> {
  const signature = 'sha256=' + crypto.createHmac('sha256', ep.secret).update(bodyStr).digest('hex');

  let status: 'SUCCESS' | 'FAILED' = 'FAILED';
  let statusCode: number | null = null;
  let responseBody: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let res: Response;
    try {
      res = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MailFlow-Event': event,
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
    // Timeout or network error — already FAILED
  }

  await prisma.webhookDelivery.create({
    data: {
      endpointId: ep.id,
      event,
      payload,
      status,
      statusCode,
      responseBody,
      attemptCount: 1,
      lastAttemptAt: new Date(),
    },
  }).catch((err) => {
    console.error('[webhook] failed to record delivery', { endpointId: ep.id, err });
  });
}
