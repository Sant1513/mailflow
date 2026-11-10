import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail';
import { prisma } from '@/lib/db/client';
import { authorizedClientFor, markAccountExpired } from '@/lib/gmail/oauth';
import { parseAddressList, parseGmailMessage, type GmailMessage } from '@/lib/gmail/parseMessage';
import { ingestInboundMessage, RetryLaterError, type IngestOutcome } from '@/lib/gmail/ingest';
import { parseUnsubscribeSubject } from '@/lib/email/unsubscribeByEmail';
import { recruiterSendRefs } from '@/lib/recruiterSend/replies';
import type { EmailProviderAccount } from '@prisma/client';

/**
 * §47-§48 inbound sync.
 *
 * Preferred path: Gmail push notification → webhook → this, using
 * users.history.list from the last stored historyId, so each sync touches
 * only what changed. Fallback path (no historyId yet, history expired, or a
 * manual "Sync Now" with no Pub/Sub configured): a bounded scan of recent
 * INBOX + SENT messages. Both feed the same ingestInboundMessage, so what
 * gets stored does not depend on which path ran.
 *
 * Busy mailboxes (§104): a team mailbox can see hundreds of new messages a
 * day, almost none of them MailFlow's. Fetching each one in full made a sync
 * take many minutes and time out on Vercel. So the loop triages first:
 *   - drafts / spam / trash are dropped from the history entry's labels
 *     without any fetch;
 *   - ids already stored are dropped in one bulk query;
 *   - messages in a known MailFlow thread (inbound OR our own Gmail replies)
 *     are fetched in full and ingested;
 *   - our own mail in an unknown thread is skipped without a fetch;
 *   - everything else gets a cheap metadata-only fetch (From, In-Reply-To,
 *     References, labels), and only mail that answers something MailFlow
 *     sent or comes from a known Contact is fetched in full.
 * Work runs a few messages at a time, under a wall-clock budget, and the
 * history cursor advances to the last record fully processed, so a run that
 * stops early resumes exactly where it left off next time (`remaining` > 0
 * tells the caller to go again).
 *
 * The Gmail calls are behind a small interface so the sync loop can be
 * exercised in tests with canned messages instead of a live mailbox.
 */

export interface HistoryEntry {
  messageId: string;
  threadId?: string | null;
  labelIds?: string[] | null;
  /** Id of the history record this message came from (history path only). */
  historyRecordId?: string | null;
}

export interface MessageMetadata {
  threadId: string | null;
  labelIds: string[];
  fromEmail: string | null;
  inReplyTo: string | null;
  references: string | null;
  /** Subject header: an "Unsubscribe <code>" email starts a new thread from someone who may not be a contact. */
  subject?: string | null;
}

export interface GmailSource {
  /**
   * Returns messages added since historyId (in history order), plus the history id to resume
   * from. With `maxEntries`, stops after about that many messages and returns the id of the
   * last history record it read, so a long backlog is worked through window by window.
   * Throws GmailHistoryGone on 404.
   */
  listHistory(startHistoryId: string, maxEntries?: number): Promise<{ entries: HistoryEntry[]; historyId: string | null }>;
  /** Bounded recent INBOX + SENT scan for the fallback path. */
  listRecentInbox(maxResults: number): Promise<{ entries: HistoryEntry[]; historyId: string | null }>;
  /** Headers + labels only: ~1/5 the cost of a full fetch. Null when the message is gone. */
  getMessageMetadata(id: string): Promise<MessageMetadata | null>;
  getMessage(id: string): Promise<GmailMessage | null>;
  getProfileHistoryId(): Promise<string | null>;
}

export class GmailHistoryGone extends Error {
  constructor() {
    super('Gmail history is no longer available from the stored historyId.');
    this.name = 'GmailHistoryGone';
  }
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | null {
  const h = (headers ?? []).find((x) => (x.name ?? '').toLowerCase() === name);
  return h?.value?.trim() || null;
}

export function gmailSourceFor(account: EmailProviderAccount): GmailSource {
  let client: gmail_v1.Gmail | null = null;
  const api = async () => {
    if (!client) client = gmailApi({ version: 'v1', auth: await authorizedClientFor(account) });
    return client;
  };

  return {
    async listHistory(startHistoryId, maxEntries) {
      const gmail = await api();
      const seen = new Set<string>();
      const entries: HistoryEntry[] = [];
      let pageToken: string | undefined;
      let newest: string | null = null;
      try {
        do {
          // A big backlog (e.g. weeks without a sync) takes longer to list than a whole run
          // may take; stop at the window size and resume from the last record read.
          if (maxEntries && entries.length >= maxEntries) {
            newest = entries[entries.length - 1]?.historyRecordId ?? newest;
            break;
          }
          const res = await gmail.users.history.list({
            userId: 'me',
            startHistoryId,
            historyTypes: ['messageAdded'],
            // No label filter: replies the team sends straight from Gmail live
            // under SENT, and the thread in MailFlow must show them too.
            maxResults: 500,
            pageToken,
          });
          for (const h of res.data.history ?? []) {
            for (const added of h.messagesAdded ?? []) {
              const id = added.message?.id;
              if (!id || seen.has(id)) continue;
              seen.add(id);
              entries.push({
                messageId: id,
                threadId: added.message?.threadId ?? null,
                labelIds: added.message?.labelIds ?? null,
                historyRecordId: h.id ?? null,
              });
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
      return { entries, historyId: newest };
    },

    async listRecentInbox(maxResults) {
      const gmail = await api();
      const res = await gmail.users.messages.list({
        userId: 'me',
        maxResults,
        // Only recent mail: this is a recovery/bootstrap path, not a backfill.
        // Inbox for student replies, Sent for the team's own Gmail replies.
        q: 'newer_than:7d (in:inbox OR in:sent)',
      });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      return {
        entries: (res.data.messages ?? [])
          .filter((m) => !!m.id)
          .map((m) => ({ messageId: m.id!, threadId: m.threadId ?? null, labelIds: null })),
        historyId: profile.data.historyId ?? null,
      };
    },

    async getMessageMetadata(id) {
      const gmail = await api();
      try {
        const res = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'In-Reply-To', 'References', 'Subject'],
        });
        const headers = res.data.payload?.headers ?? undefined;
        return {
          threadId: res.data.threadId ?? null,
          labelIds: res.data.labelIds ?? [],
          fromEmail: parseAddressList(headerValue(headers, 'from'))[0]?.email?.toLowerCase() ?? null,
          inReplyTo: headerValue(headers, 'in-reply-to'),
          references: headerValue(headers, 'references'),
          subject: headerValue(headers, 'subject'),
        };
      } catch (err) {
        const status = Number((err as { code?: number }).code);
        if (status === 404) return null;
        throw err;
      }
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
  /** Messages listed by Gmail for this window. */
  listed: number;
  /** Messages fetched in full and handed to ingestion. */
  fetched: number;
  stored: number;
  duplicates: number;
  ignored: number;
  outbound: number;
  /** Messages left unprocessed because the run hit its budget; call again. */
  remaining: number;
  newHistoryId: string | null;
  elapsedMs: number;
  errors: string[];
}

export interface SyncOptions {
  /** Stop starting new work after this many ms (the cursor still advances to what was done). */
  budgetMs?: number;
  /** Hard cap on messages triaged in one run. */
  maxMessages?: number;
  /** Parallel Gmail fetches. */
  concurrency?: number;
}

const SCAN_LIMIT = 100;
/** Messages listed per run on the history path; the rest are picked up by the next run. */
const HISTORY_WINDOW = 1000;
const DEFAULT_BUDGET_MS = 40_000;
const DEFAULT_MAX_MESSAGES = 600;
const DEFAULT_CONCURRENCY = 6;
const BATCH = 40;
/** How long one message that keeps failing may hold a mailbox's sync before it is skipped. */
const STUCK_SKIP_MS = 6 * 3_600_000;
const SKIP_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH']);

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function isCodedUnsubscribe(subject: string | null | undefined): boolean {
  const code = parseUnsubscribeSubject(subject);
  return !!code && code.kind !== 'plain';
}

/**
 * A per-message error that may pass on its own (Gmail rate limit or 5xx, network, database
 * timeout, or ingest asking to retry). The cursor is held before such a message so the next run
 * retries it; a permanent error is logged and skipped so one bad message can't stall the mailbox.
 */
export function isTransientSyncError(err: unknown): boolean {
  if (err instanceof RetryLaterError) return true;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown }; message?: unknown };
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  const message = String(e?.message ?? err ?? '');
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|rate ?limit|backend error|P1001|P1002|P1008|P1017|P2024|P2028|can't reach database|timed out/i.test(message);
}

function referencedIds(meta: { inReplyTo: string | null; references: string | null }): string[] {
  return [meta.inReplyTo, ...(meta.references ?? '').split(/\s+/)].map((s) => s?.trim()).filter((s): s is string => !!s);
}

/**
 * Syncs one mailbox. Persists the new historyId only after every message in
 * the window has been processed — or, when the budget runs out first, the
 * id of the last history record fully processed — so a crash or an early
 * stop re-processes at most the tail of the window, and idempotent
 * ingestion makes that harmless (§48).
 */
export async function syncAccount(
  account: EmailProviderAccount,
  source: GmailSource = gmailSourceFor(account),
  options: SyncOptions = {}
): Promise<SyncResult> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const result: SyncResult = {
    accountId: account.id,
    path: 'scan',
    listed: 0,
    fetched: 0,
    stored: 0,
    duplicates: 0,
    ignored: 0,
    outbound: 0,
    remaining: 0,
    newHistoryId: null,
    elapsedMs: 0,
    errors: [],
  };
  const finish = () => {
    result.elapsedMs = Date.now() - startedAt;
    return result;
  };

  let entries: HistoryEntry[] = [];
  let historyId: string | null = null;

  try {
    if (account.gmailHistoryId) {
      try {
        const h = await source.listHistory(account.gmailHistoryId, HISTORY_WINDOW);
        entries = h.entries;
        historyId = h.historyId;
        result.path = 'history';
      } catch (err) {
        if (!(err instanceof GmailHistoryGone)) throw err;
        const s = await source.listRecentInbox(SCAN_LIMIT);
        entries = s.entries;
        historyId = s.historyId;
      }
    } else {
      const s = await source.listRecentInbox(SCAN_LIMIT);
      entries = s.entries;
      historyId = s.historyId;
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/invalid_grant|unauthorized|401/i.test(message)) {
      await markAccountExpired(account.id, message);
    }
    result.errors.push(`list: ${message}`);
    return finish();
  }

  result.listed = entries.length;
  const ownAddress = account.emailAddress.toLowerCase();

  // ── Triage 1: labels we never want, and ids already stored (bulk) ──
  const stored = new Set<string>();
  for (const ids of chunk(entries.map((e) => e.messageId), 500)) {
    const rows = await prisma.conversationMessage.findMany({
      where: { gmailMessageId: { in: ids } },
      select: { gmailMessageId: true },
    });
    for (const r of rows) if (r.gmailMessageId) stored.add(r.gmailMessageId);
  }

  const threadIds = Array.from(new Set(entries.map((e) => e.threadId).filter((t): t is string => !!t)));
  const knownThreads = new Set<string>();
  for (const ids of chunk(threadIds, 500)) {
    const rows = await prisma.conversation.findMany({
      where: { emailProviderAccountId: account.id, gmailThreadId: { in: ids } },
      select: { gmailThreadId: true },
    });
    for (const r of rows) if (r.gmailThreadId) knownThreads.add(r.gmailThreadId);
    // Threads started by a Recruiter Bulk Send from this mailbox: recruiters' replies land there.
    for (const t of (await recruiterSendRefs(account, ids, [])).threads) knownThreads.add(t);
  }

  const outOfBudget = () => Date.now() - startedAt > budgetMs;
  let lastDoneRecordId: string | null = null;
  let processed = 0;
  // The first message keeps failing in a way that may pass (cursor held with no progress).
  let stuckNow = false;
  let stuckCleared = false;

  const ingestFull = async (messageId: string) => {
    const raw = await source.getMessage(messageId);
    if (!raw) return;
    result.fetched += 1;
    const outcome: IngestOutcome = await ingestInboundMessage(account, parseGmailMessage(raw));
    if (outcome.status === 'STORED') result.stored += 1;
    else if (outcome.status === 'DUPLICATE') result.duplicates += 1;
    else if (outcome.status === 'OUTBOUND_ALREADY_RECORDED') result.outbound += 1;
    else result.ignored += 1;
  };

  // ── Triage 2 + ingest, in batches so a run can stop cleanly on budget ──
  const batches = chunk(entries, BATCH);
  for (let b = 0; b < batches.length; b += 1) {
    // Always finish at least one batch: when listing alone used the budget, stopping here
    // would leave the cursor where it was and every run would stall on the same window.
    if (b > 0 && (outOfBudget() || processed >= maxMessages)) {
      result.remaining = entries.length - processed;
      break;
    }
    const batch = batches[b] ?? [];

    const needMeta: HistoryEntry[] = [];
    const toIngest: string[] = [];
    for (const e of batch) {
      if (stored.has(e.messageId)) {
        result.duplicates += 1;
      } else if ((e.labelIds ?? []).some((l) => SKIP_LABELS.has(l))) {
        result.ignored += 1;
      } else if (e.threadId && knownThreads.has(e.threadId)) {
        toIngest.push(e.messageId);
      } else if (e.labelIds && e.labelIds.includes('SENT') && !e.labelIds.includes('INBOX')) {
        // Our own mail in a thread MailFlow does not know: nothing to attach it to.
        result.outbound += 1;
      } else {
        needMeta.push(e);
      }
    }

    // Cheap look at the rest: who sent it and what it answers.
    // Messages that failed in a way that may pass: the cursor stops before the first of them.
    const retryIds = new Set<string>();
    const noteError = (messageId: string, err: unknown) => {
      result.errors.push(`${messageId}: ${(err as Error)?.message ?? String(err)}`);
      if (isTransientSyncError(err)) retryIds.add(messageId);
    };

    const metas = await mapLimit(needMeta, concurrency, async (e) => {
      try {
        return { entry: e, meta: await source.getMessageMetadata(e.messageId), error: null as unknown };
      } catch (err) {
        return { entry: e, meta: null, error: err as unknown };
      }
    });

    const candidates: { entry: HistoryEntry; meta: MessageMetadata }[] = [];
    for (const m of metas) {
      if (m.error) {
        noteError(m.entry.messageId, m.error);
        continue;
      }
      if (!m.meta) continue; // deleted between list and fetch
      if (m.meta.labelIds.some((l) => SKIP_LABELS.has(l))) {
        result.ignored += 1;
      } else if (m.meta.threadId && knownThreads.has(m.meta.threadId)) {
        toIngest.push(m.entry.messageId);
      } else if (m.meta.fromEmail === ownAddress) {
        result.outbound += 1;
      } else if (isCodedUnsubscribe(m.meta.subject)) {
        // "Unsubscribe rb-…/cj-…" from the Unsubscribe button in our emails: a new thread, usually
        // from someone who isn't a contact yet (a BCC recruiter), so it would never pass the rules
        // below. A plain "Unsubscribe" with no code still has to pass them.
        toIngest.push(m.entry.messageId);
      } else {
        candidates.push({ entry: m.entry, meta: m.meta });
      }
    }

    if (candidates.length > 0) {
      // Rule 2 (answers something we sent) and rule 3 (known Contact), each
      // one bulk query for the whole batch instead of two per message.
      const refs = Array.from(new Set(candidates.flatMap((c) => referencedIds(c.meta))));
      const froms = Array.from(new Set(candidates.map((c) => c.meta.fromEmail).filter((f): f is string => !!f)));
      const [jobs, contacts] = await Promise.all([
        refs.length > 0
          ? prisma.emailJob.findMany({
              where: { messageIdHeader: { in: refs }, emailProviderAccountId: account.id },
              select: { messageIdHeader: true },
            })
          : Promise.resolve([] as { messageIdHeader: string | null }[]),
        froms.length > 0
          ? prisma.contact.findMany({
              where: { workspaceId: account.workspaceId, primaryEmail: { in: froms } },
              select: { primaryEmail: true },
            })
          : Promise.resolve([] as { primaryEmail: string }[]),
      ]);
      const answered = new Set(jobs.map((j) => j.messageIdHeader).filter((x): x is string => !!x));
      for (const id of (await recruiterSendRefs(account, [], refs)).messageIds) answered.add(id);
      const knownContacts = new Set(contacts.map((c) => c.primaryEmail.toLowerCase()));
      for (const c of candidates) {
        const ours = referencedIds(c.meta).some((r) => answered.has(r)) || (!!c.meta.fromEmail && knownContacts.has(c.meta.fromEmail));
        if (ours) toIngest.push(c.entry.messageId);
        else result.ignored += 1;
      }
    }

    // Full fetch + ingest only for what belongs to MailFlow. Sequential per
    // thread order is not required: ingestion is idempotent and keyed by id.
    await mapLimit(toIngest, Math.min(concurrency, 3), async (id) => {
      try {
        await ingestFull(id);
        // A stored message makes its thread known for the rest of the run.
      } catch (err) {
        noteError(id, err);
      }
    });

    let firstRetry = retryIds.size ? batch.findIndex((e) => retryIds.has(e.messageId)) : -1;
    if (firstRetry >= 0 && processed === 0 && firstRetry === 0) {
      // Nothing before the failed message: holding the cursor makes no progress. After
      // STUCK_SKIP_MS of that, the message is passed like a permanent error so one message
      // that keeps failing can't stop the mailbox's replies for good.
      const since = account.syncStuckSince ? new Date(account.syncStuckSince).getTime() : null;
      if (since !== null && Date.now() - since > STUCK_SKIP_MS) {
        result.errors.push(`${batch[0]!.messageId}: skipped after ${STUCK_SKIP_MS / 3_600_000} h of retries`);
        firstRetry = -1;
        stuckCleared = true;
      } else {
        stuckNow = true;
      }
    }
    if (firstRetry >= 0) {
      // Hold the cursor on the last history record wholly before the failed message (records
      // can hold several messages), so the next run fetches it again. Ingestion is idempotent,
      // so anything re-read after that point is recorded once.
      const failedRecord = batch[firstRetry]?.historyRecordId ?? null;
      for (let i = firstRetry - 1; i >= 0; i--) {
        const rec = batch[i]?.historyRecordId;
        if (rec && rec !== failedRecord) {
          lastDoneRecordId = rec;
          break;
        }
      }
      processed += firstRetry;
      result.remaining = entries.length - processed;
      break;
    }

    processed += batch.length;
    lastDoneRecordId = batch[batch.length - 1]?.historyRecordId ?? lastDoneRecordId;
  }

  // Cursor: the newest history id when the whole window was attempted,
  // otherwise the last record we finished (history path). A message that
  // failed for good (permanent error) is logged and passed, so one bad message
  // can't stop every future reply from syncing; one that failed for a reason
  // that may pass (isTransientSyncError) holds the cursor before it.
  const cursor = result.remaining > 0 ? (result.path === 'history' ? lastDoneRecordId : null) : historyId;
  if (cursor) {
    await prisma.emailProviderAccount.update({
      where: { id: account.id },
      data: { gmailHistoryId: cursor, lastVerifiedAt: new Date(), lastSyncAt: new Date(), ...(stuckNow ? {} : { syncStuckSince: null }) },
    });
    result.newHistoryId = cursor;
  }
  if (stuckNow && !account.syncStuckSince) {
    await prisma.emailProviderAccount.update({ where: { id: account.id }, data: { syncStuckSince: new Date() } });
  } else if (stuckCleared && !cursor) {
    await prisma.emailProviderAccount.update({ where: { id: account.id }, data: { syncStuckSince: null } });
  }

  return finish();
}

/**
 * Runs syncAccount repeatedly until the window is drained or `totalBudgetMs`
 * is spent. Used by the cron and the Sync Now route so one call catches up a
 * busy mailbox without the client having to loop.
 */
export async function syncAccountToCompletion(
  account: EmailProviderAccount,
  options: { totalBudgetMs?: number; maxRounds?: number } = {}
): Promise<SyncResult & { rounds: number }> {
  const totalBudgetMs = options.totalBudgetMs ?? 45_000;
  const maxRounds = options.maxRounds ?? 8;
  const startedAt = Date.now();
  let current = account;
  let rounds = 0;
  let total: (SyncResult & { rounds: number }) | undefined;
  while (rounds < maxRounds) {
    const left = totalBudgetMs - (Date.now() - startedAt);
    if (left < 5_000 && rounds > 0) break;
    const r = await syncAccount(current, gmailSourceFor(current), { budgetMs: Math.max(5_000, Math.min(DEFAULT_BUDGET_MS, left)) });
    rounds += 1;
    total = total
      ? {
          ...total,
          listed: total.listed + r.listed,
          fetched: total.fetched + r.fetched,
          stored: total.stored + r.stored,
          duplicates: total.duplicates + r.duplicates,
          ignored: total.ignored + r.ignored,
          outbound: total.outbound + r.outbound,
          remaining: r.remaining,
          newHistoryId: r.newHistoryId ?? total.newHistoryId,
          elapsedMs: Date.now() - startedAt,
          errors: [...total.errors, ...r.errors],
          rounds,
        }
      : { ...r, rounds };
    if (r.remaining === 0 || r.errors.some((e) => e.startsWith('list:')) || !r.newHistoryId) break;
    current = { ...current, gmailHistoryId: r.newHistoryId };
  }
  return total ?? { accountId: account.id, path: 'history', listed: 0, fetched: 0, stored: 0, duplicates: 0, ignored: 0, outbound: 0, remaining: 0, newHistoryId: null, elapsedMs: 0, errors: [], rounds: 0 };
}
