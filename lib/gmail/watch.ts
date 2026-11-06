import { gmail as gmailApi } from '@googleapis/gmail';
import type { EmailProviderAccount } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { authorizedClientFor } from '@/lib/gmail/oauth';

/**
 * Gmail push notifications. Gmail tells Google Cloud Pub/Sub the moment a connected mailbox
 * changes; Pub/Sub calls /api/webhooks/gmail, which syncs that mailbox at once — replies show
 * up in seconds instead of waiting for the 15-minute sync. A "watch" lasts at most 7 days, so
 * it is renewed when it has less than a day left (checked on every scheduled sync).
 *
 * Off unless GMAIL_PUBSUB_TOPIC is set ("projects/<project>/topics/<topic>"); the scheduled
 * sync keeps working either way.
 */
export const RENEW_BEFORE_MS = 24 * 3600_000;

export function pushEnabled(): boolean {
  return !!process.env.GMAIL_PUBSUB_TOPIC?.trim();
}

export function watchDue(account: Pick<EmailProviderAccount, 'watchExpiresAt'>, now = Date.now()): boolean {
  return !account.watchExpiresAt || account.watchExpiresAt.getTime() - now < RENEW_BEFORE_MS;
}

/** Starts or renews the watch when due. Returns the new expiry, or null when nothing was done. */
export async function ensureWatch(account: EmailProviderAccount): Promise<Date | null> {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC?.trim();
  if (!topicName || account.status !== 'CONNECTED' || !account.refreshTokenEnc || !watchDue(account)) return null;
  const gmail = gmailApi({ version: 'v1', auth: await authorizedClientFor(account) });
  // Inbox (replies) and Sent (replies the team sends straight from Gmail).
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: { topicName, labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'include' },
  });
  const expiresAt = res.data.expiration ? new Date(Number(res.data.expiration)) : new Date(Date.now() + 7 * 86_400_000);
  await prisma.emailProviderAccount.update({
    where: { id: account.id },
    // A first watch also seeds the sync cursor, so the next sync starts from now.
    data: { watchExpiresAt: expiresAt, ...(account.gmailHistoryId ? {} : { gmailHistoryId: res.data.historyId ?? undefined }) },
  });
  return expiresAt;
}
