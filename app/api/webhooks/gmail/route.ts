import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { syncAccount } from '@/lib/gmail/sync';
import { getQueue, QUEUE_NAMES } from '@/lib/queue/queues';

/**
 * §103 Gmail push notifications via Google Cloud Pub/Sub.
 *
 * Pub/Sub POSTs { message: { data: base64({ emailAddress, historyId }) } }.
 * The payload only tells us WHICH mailbox changed — never the mail itself —
 * so an attacker who forges it can at most trigger a sync we'd have done
 * anyway. We still verify a shared token on the URL so the endpoint cannot
 * be used to make us hammer Gmail on demand.
 *
 * The handler acks fast and defers the real work: Pub/Sub retries anything
 * that does not 2xx within its deadline, and a sync can take seconds.
 */
export const POST = async (req: Request) => {
  const expected = process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN;
  const url = new URL(req.url);
  if (!expected || url.searchParams.get('token') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let emailAddress: string | null = null;
  try {
    const body = (await req.json()) as { message?: { data?: string } };
    const decoded = body.message?.data ? Buffer.from(body.message.data, 'base64').toString('utf8') : '{}';
    const payload = JSON.parse(decoded) as { emailAddress?: string; historyId?: string | number };
    emailAddress = payload.emailAddress?.toLowerCase() ?? null;
  } catch {
    // Malformed — ack it so Pub/Sub stops retrying something we can never parse.
    return NextResponse.json({ ok: true, ignored: 'unparseable' });
  }

  if (!emailAddress) return NextResponse.json({ ok: true, ignored: 'no address' });

  const account = await prisma.emailProviderAccount.findFirst({
    where: { emailAddress, status: 'CONNECTED', refreshTokenEnc: { not: null } },
  });
  if (!account) return NextResponse.json({ ok: true, ignored: 'unknown mailbox' });

  // Prefer the queue so the request returns immediately; fall back to an
  // inline sync when there is no Redis, since the alternative is dropping
  // the notification on the floor.
  const queue = getQueue(QUEUE_NAMES.GMAIL_SYNC);
  if (queue) {
    await queue.add('sync', { accountId: account.id }, { jobId: `sync-${account.id}-${Date.now()}` });
    return NextResponse.json({ ok: true, queued: true });
  }

  const result = await syncAccount(account);
  return NextResponse.json({ ok: true, queued: false, stored: result.stored, errors: result.errors.length });
};
