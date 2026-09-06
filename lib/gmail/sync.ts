import { google, type gmail_v1 } from 'googleapis';
import { prisma } from '@/lib/db/client';
import { authorizedClientFor, markAccountExpired } from '@/lib/gmail/oauth';
import { parseGmailMessage, type GmailMessage } from '@/lib/gmail/parseMessage';
import { ingestInboundMessage, type IngestOutcome } from '@/lib/gmail/ingest';
import type { EmailProviderAccount } from '@prisma/client';

/**
 * §47-§48 inbound sync.
 *
 * Preferred path: Gmail push notification → webhook → this, using
 * users.history.list from the last stored historyId, so each sync touches
 * only what changed. Fallback path (no historyId yet, history expired, or a
 * manual "Sync Now" with no Pub/Sub configured): a bounded scan of recent
 * INBOX messages. Both feed the same ingestInboundMessage, so what gets
 * stored does not depend on which path ran.
 *
 * The Gmail calls are behind a small interface so the sync loop can be
 * exercised in tests with canned messages instead of a live mailbox.
 */

export interface GmailSource {
  /** Returns message ids that changed since historyId, plus the new historyId. Throws GmailHistoryGone on 404. */
  listHistory(startHistoryId: string): Promise<{ messageIds: string[]; historyId: string | null }>;
  /** Bounded recent-INBOX scan for the fallback path. */
  listRecentInbox(maxResults: number): Promise<{ messageIds: string[]; historyId: string | null }>;
  getMessage(id: string): Promise<GmailMessage | null>;
  getProfileHistoryId(): Promise<string | null>;
}

export class GmailHistoryGone extends Error {
  constructor() {
    super('Gmail history is no longer available from the stored historyId.');
    this.name = 'GmailHistoryGone';
  }
}

export function gmailSourceFor(account: EmailProviderAccount): GmailSource {
  let client: gmail_v1.Gmail | null = null;
  const api = async () => {
    if (!client) client = google.gmail({ version: 'v1', auth: await authorizedClientFor(account) });
    return client;
  };

  return {
    async listHistory(startHistoryId) {
      const gmail = await api();
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let newest: string | null = null;
      try {
        do {
          const res = await gmail.users.history.list({
            userId: 'me',
            startHistoryId,
            historyTypes: ['messageAdded'],
            labelId: 'INBOX',
            pageToken,
          });
          for (const h of res.data.history ?? []) {
            for (const added of h.messagesAdded ?? []) {
              if (added.message?.id) ids.add(added.message.id);
            }
          }
          newest = res.data.historyId ?? newest;
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (err) {
        const status = Number((err as { code?: number; status?: number }).code ?? (err as { status?: number }).status);
        // 404 = the historyId is older than Gmail retains (~a week). The
        // caller falls back to a scan rather than failing silently (§105).
        if (status === 404) throw new GmailHistoryGone();
        throw err;
      }
      return { messageIds: Array.from(ids), historyId: newest };
    },

    async listRecentInbox(maxResults) {
      const gmail = await api();
      const res = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        maxResults,
        // Only recent mail: this is a recovery/bootstrap path, not a backfill.
        q: 'newer_than:7d',
      });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      return {
        messageIds: (res.data.messages ?? []).map((m) => m.id!).filter(Boolean),
        historyId: profile.data.historyId ?? null,
      };
    },

    async getMessage(id) {
      const gmail = await api();
      try {
        const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        return res.data as GmailMessage;
      } catch (err) {
        const status = Number((err as { code?: number }).code);
        // Deleted between listing and fetching — nothing to ingest (§105).
        if (status === 404) return null;
        throw err;
      }
    },

    async getProfileHistoryId() {
      const gmail = await api();
      const profile = await gmail.users.getProfile({ userId: 'me' });
      return profile.data.historyId ?? null;
    },
  };
}

export interface SyncResult {
  accountId: string;
  path: 'history' | 'scan';
  fetched: number;
  stored: number;
  duplicates: number;
  ignored: number;
  outbound: number;
  newHistoryId: string | null;
  errors: string[];
}

const SCAN_LIMIT = 100;

/**
 * Syncs one mailbox. Persists the new historyId only after every message in
 * the window has been processed, so a crash mid-way re-processes the same
 * window next time — and idempotent ingestion makes that harmless (§48).
 */
export async function syncAccount(
  account: EmailProviderAccount,
  source: GmailSource = gmailSourceFor(account)
): Promise<SyncResult> {
  const result: SyncResult = {
    accountId: account.id,
    path: 'scan',
    fetched: 0,
    stored: 0,
    duplicates: 0,
    ignored: 0,
    outbound: 0,
    newHistoryId: null,
    errors: [],
  };

  let messageIds: string[] = [];
  let historyId: string | null = null;

  try {
    if (account.gmailHistoryId) {
      try {
        const h = await source.listHistory(account.gmailHistoryId);
        messageIds = h.messageIds;
        historyId = h.historyId;
        result.path = 'history';
      } catch (err) {
        if (!(err instanceof GmailHistoryGone)) throw err;
        const s = await source.listRecentInbox(SCAN_LIMIT);
        messageIds = s.messageIds;
        historyId = s.historyId;
      }
    } else {
      const s = await source.listRecentInbox(SCAN_LIMIT);
      messageIds = s.messageIds;
      historyId = s.historyId;
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/invalid_grant|unauthorized|401/i.test(message)) {
      await markAccountExpired(account.id, message);
    }
    result.errors.push(`list: ${message}`);
    return result;
  }

  for (const id of messageIds) {
    try {
      const raw = await source.getMessage(id);
      if (!raw) continue;
      result.fetched += 1;
      const outcome: IngestOutcome = await ingestInboundMessage(account, parseGmailMessage(raw));
      if (outcome.status === 'STORED') result.stored += 1;
      else if (outcome.status === 'DUPLICATE') result.duplicates += 1;
      else if (outcome.status === 'OUTBOUND_ALREADY_RECORDED') result.outbound += 1;
      else result.ignored += 1;
    } catch (err) {
      result.errors.push(`${id}: ${(err as Error).message ?? String(err)}`);
    }
  }

  // Only advance the cursor when the whole window was attempted, and only
  // if we actually have one. A run with errors still advances: the failed
  // ids are logged above, and stalling the cursor forever on one bad message
  // would stop every future reply from syncing.
  if (historyId) {
    await prisma.emailProviderAccount.update({
      where: { id: account.id },
      data: { gmailHistoryId: historyId, lastVerifiedAt: new Date() },
    });
    result.newHistoryId = historyId;
  }

  return result;
}
