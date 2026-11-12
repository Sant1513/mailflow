import { gmail as gmailApi } from '@googleapis/gmail';
import { authorizedClientFor } from '@/lib/gmail/oauth';
import type { EmailProviderAccount } from '@prisma/client';

/**
 * Read-only Gmail search (users.messages.list with a Gmail query), newest first, up to `max`
 * message ids. Used by one-off scripts such as scripts/backfill-ndr.ts.
 */
export async function searchMessageIds(account: EmailProviderAccount, q: string, max = 500): Promise<{ id: string; threadId: string | null }[]> {
  const gmail = gmailApi({ version: 'v1', auth: await authorizedClientFor(account) });
  const out: { id: string; threadId: string | null }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: Math.min(500, max - out.length), pageToken, includeSpamTrash: false });
    for (const m of res.data.messages ?? []) if (m.id) out.push({ id: m.id, threadId: m.threadId ?? null });
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && out.length < max);
  return out;
}
