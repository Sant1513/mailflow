import type { EmailProviderAccount } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { gmailSourceFor } from '@/lib/gmail/sync';
import { searchMessageIds } from '@/lib/gmail/search';
import type { GmailMessage } from '@/lib/gmail/parseMessage';
import { ndrSearchQuery, processNotice, type NoticeResult } from '@/lib/email/ndrBackfill';
import { willSuppress } from '@/lib/email/ndr';

/**
 * The bounce scan: every connected mailbox is searched in Gmail for delivery-failure notices (bounces, blocks, "mailbox full",
 * delays, spam rejections) every 15 minutes, and each notice goes through the same reader and rules as live inbox sync
 * (lib/email/ndr.ts), so the dead address is suppressed. It does NOT depend on inbox sync, which only covers some mailboxes,
 * and it never stores anyone's mail: it only searches for notices.
 *
 * Nothing is skipped or read twice more than needed:
 *   - each mailbox remembers how far it has read (EmailProviderAccount.bounceScanAt) and asks Gmail only for what is newer,
 *     with a 2-hour overlap (reading a notice again is harmless: suppressions are upserts, soft bounces are keyed by message id);
 *   - notices are handled oldest first, so a long backlog or a run out of time resumes exactly where it stopped;
 *   - if a notice could not be read, the mailbox steps back 6 hours so it is tried again on the next runs;
 *   - mailboxes are visited in the order of who was scanned longest ago, so a slow mailbox cannot starve the rest;
 *   - a mailbox that cannot be read at all (revoked access, Gmail down) keeps its error, shown on the Suppressions page.
 */
export const OVERLAP_MS = 2 * 3600_000;
export const RETRY_STEP_BACK_MS = 6 * 3600_000;
export const FIRST_WINDOW_DAYS = 3;
export const MAX_PER_MAILBOX = 400;
export const CONCURRENCY = 4;
/** Time kept at the end of a run to save progress. */
const SAFETY_MS = 4_000;

export interface MailboxReader {
  /** Message ids matching a Gmail search, newest first. */
  search(q: string, max: number): Promise<{ id: string }[]>;
  get(id: string): Promise<GmailMessage | null>;
}

export interface ScanDeps {
  reader(account: EmailProviderAccount): MailboxReader;
  process(account: EmailProviderAccount, raw: GmailMessage): Promise<NoticeResult>;
}

const ownDomains = () => (process.env.ALLOWED_EMAIL_DOMAIN ?? 'masaischool.com,neevlabs.ai').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

export const defaultDeps: ScanDeps = {
  reader(account) {
    const source = gmailSourceFor(account);
    return { search: (q, max) => searchMessageIds(account, q, max, { includeSpamTrash: true }), get: (id) => source.getMessage(id) };
  },
  // Same as scripts/backfill-ndr.ts --apply --include-outside: a hard bounce on an email sent outside MailFlow counts too.
  process: (account, raw) => processNotice(account, raw, { apply: true, includeOutside: true, ownDomains: ownDomains() }),
};

export interface MailboxResult {
  email: string;
  ok: boolean;
  notices: number;
  suppressed: number;
  noted: number;
  errors: number;
  /** More notices were waiting than one run reads, or time ran out: the next run continues from here. */
  more: boolean;
  from: string;
  error?: string;
}

export interface ScanSummary {
  mailboxes: MailboxResult[];
  /** Connected mailboxes not reached this run (out of time); they go first next run. */
  notReached: string[];
  notices: number;
  suppressed: number;
  errors: number;
}

export async function scanMailbox(
  account: EmailProviderAccount,
  opts: { deadline: number; clock?: () => number; firstWindowDays?: number; maxPerMailbox?: number; concurrency?: number; deps?: ScanDeps },
): Promise<MailboxResult> {
  const deps = opts.deps ?? defaultDeps;
  const clock = opts.clock ?? Date.now;
  const scanStart = clock();
  const max = opts.maxPerMailbox ?? MAX_PER_MAILBOX;
  const concurrency = opts.concurrency ?? CONCURRENCY;
  const prev = account.bounceScanAt?.getTime() ?? null;
  const since = prev !== null ? prev - OVERLAP_MS : scanStart - (opts.firstWindowDays ?? FIRST_WINDOW_DAYS) * 86_400_000;
  const result: MailboxResult = { email: account.emailAddress, ok: true, notices: 0, suppressed: 0, noted: 0, errors: 0, more: false, from: new Date(since).toISOString() };

  let ids: { id: string }[];
  const reader = deps.reader(account);
  try {
    ids = (await reader.search(ndrSearchQuery(0, since / 1000), max + 1)).reverse(); // oldest first
  } catch (err) {
    const message = ((err as Error).message ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
    result.ok = false;
    result.error = message;
    await prisma.emailProviderAccount.update({ where: { id: account.id }, data: { bounceScanError: `Could not search this mailbox: ${message}` } }).catch(() => undefined);
    return result;
  }
  const capped = ids.length > max;
  ids = ids.slice(0, max);

  let latest: number | null = null;
  let incomplete = false;
  for (let i = 0; i < ids.length; i += concurrency) {
    if (clock() > opts.deadline - SAFETY_MS) { incomplete = true; break; }
    const chunk = ids.slice(i, i + concurrency);
    const done = await Promise.all(chunk.map(async ({ id }) => {
      try {
        const raw = await reader.get(id);
        if (!raw) return null;
        return await deps.process(account, raw);
      } catch (err) {
        result.errors += 1;
        console.error(`[bounce-scan] ${account.emailAddress}: notice ${id} could not be read`, (err as Error).message);
        return null;
      }
    }));
    for (const r of done) {
      if (!r) continue;
      result.notices += 1;
      for (const a of r.actions) if (willSuppress(a.decision)) result.suppressed += 1; else result.noted += 1;
      latest = Math.max(latest ?? 0, r.receivedAt.getTime());
    }
  }
  result.more = capped || incomplete;

  // How far this mailbox has now been read.
  let advanceTo: number | null;
  if (!result.more) advanceTo = scanStart;
  else advanceTo = latest !== null ? latest : prev; // oldest-first: everything up to the newest handled notice is done
  if (result.errors > 0) advanceTo = Math.min(advanceTo ?? scanStart, scanStart - RETRY_STEP_BACK_MS);
  await prisma.emailProviderAccount.update({
    where: { id: account.id },
    data: {
      ...(advanceTo !== null ? { bounceScanAt: new Date(advanceTo) } : {}),
      bounceScanError: result.errors > 0 ? `${result.errors} notice(s) could not be read; they will be tried again.` : null,
      bounceScanNotices: { increment: result.notices },
    },
  });
  return result;
}

/** Scans every connected mailbox, the one scanned longest ago first, until the time budget is used. */
export async function runBounceScan(opts: { budgetMs?: number; clock?: () => number; onlyMailbox?: string; deps?: ScanDeps; firstWindowDays?: number; maxPerMailbox?: number; concurrency?: number } = {}): Promise<ScanSummary> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? 50_000);
  const accounts = await prisma.emailProviderAccount.findMany({
    where: { status: 'CONNECTED', refreshTokenEnc: { not: null }, ...(opts.onlyMailbox ? { emailAddress: { equals: opts.onlyMailbox, mode: 'insensitive' as const } } : {}) },
    orderBy: [{ bounceScanAt: { sort: 'asc', nulls: 'first' } }, { emailAddress: 'asc' }],
  });
  const summary: ScanSummary = { mailboxes: [], notReached: [], notices: 0, suppressed: 0, errors: 0 };
  for (const account of accounts) {
    if (clock() > deadline - SAFETY_MS - 2_000) { summary.notReached.push(account.emailAddress); continue; }
    const r = await scanMailbox(account, { deadline, clock, deps: opts.deps, firstWindowDays: opts.firstWindowDays, maxPerMailbox: opts.maxPerMailbox, concurrency: opts.concurrency });
    summary.mailboxes.push(r);
    summary.notices += r.notices;
    summary.suppressed += r.suppressed;
    summary.errors += r.errors + (r.ok ? 0 : 1);
  }
  return summary;
}

/* ---------------- what the Suppressions page shows ---------------- */

export interface ScanStatus {
  /** Connected mailboxes in the organisation. */
  connected: number;
  /** Scanned within the last hour. */
  fresh: number;
  /** Never scanned yet. */
  never: number;
  /** The oldest "read up to" among connected mailboxes (null when none is scanned). */
  oldest: string | null;
  newest: string | null;
  /** Mailboxes whose last scan failed or left notices unread. */
  failing: { email: string; error: string }[];
  /** Mailboxes MailFlow cannot read (disconnected, expired, or no stored access): their bounces are NOT being captured. */
  unreadable: { email: string; status: string }[];
  notices: number;
  /** One line per mailbox (only when asked for: the super-admin panel). */
  mailboxes?: MailboxStatus[];
}

export interface MailboxStatus {
  email: string;
  /** Who owns the mailbox. */
  user: string;
  userId: string;
  /** CONNECTED, or why it cannot be read. */
  state: string;
  readable: boolean;
  /** Last time the scan finished reading this mailbox up to now (null = never). */
  lastSyncedAt: string | null;
  notices: number;
  error: string | null;
  /** What this user's workspace has on the suppression list (the report). */
  suppressions: { total: number; bounced: number; complaints: number; unsubscribed: number; byCategory: Record<string, number> };
}

export async function scanStatus(organizationId: string, now = Date.now(), opts: { mailboxes?: boolean } = {}): Promise<ScanStatus> {
  const all = await prisma.emailProviderAccount.findMany({
    where: { organizationId },
    select: { emailAddress: true, userId: true, status: true, refreshTokenEnc: true, bounceScanAt: true, bounceScanError: true, bounceScanNotices: true },
    orderBy: { emailAddress: 'asc' },
  });
  const readable = all.filter((a) => a.status === 'CONNECTED' && a.refreshTokenEnc);
  const times = readable.map((a) => a.bounceScanAt?.getTime()).filter((t): t is number => typeof t === 'number');
  return {
    connected: readable.length,
    fresh: readable.filter((a) => a.bounceScanAt && now - a.bounceScanAt.getTime() < 3600_000).length,
    never: readable.filter((a) => !a.bounceScanAt).length,
    oldest: times.length ? new Date(Math.min(...times)).toISOString() : null,
    newest: times.length ? new Date(Math.max(...times)).toISOString() : null,
    failing: readable.filter((a) => a.bounceScanError).map((a) => ({ email: a.emailAddress, error: a.bounceScanError! })),
    unreadable: all.filter((a) => !(a.status === 'CONNECTED' && a.refreshTokenEnc)).map((a) => ({ email: a.emailAddress, status: a.status === 'CONNECTED' ? 'NO ACCESS SAVED' : a.status })),
    notices: all.reduce((n, a) => n + a.bounceScanNotices, 0),
    ...(opts.mailboxes ? { mailboxes: await mailboxLines(organizationId, all) } : {}),
  };
}

async function mailboxLines(organizationId: string, all: { emailAddress: string; userId: string; status: string; refreshTokenEnc: string | null; bounceScanAt: Date | null; bounceScanError: string | null; bounceScanNotices: number }[]): Promise<MailboxStatus[]> {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(all.map((a) => a.userId))] } }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  // Entries saved in each user's workspace (a bounce is saved once, where it happened: lib/suppressions/scope.ts).
  const workspaces = await prisma.workspace.findMany({ where: { organizationId }, select: { id: true, ownerId: true } });
  const ownerOf = new Map(workspaces.map((w) => [w.id, w.ownerId]));
  const groups = await prisma.emailSuppression.groupBy({ by: ['workspaceId', 'reason', 'category'], where: { workspaceId: { in: workspaces.map((w) => w.id) } }, _count: { _all: true } });
  const report = new Map<string, MailboxStatus['suppressions']>();
  const blank = (): MailboxStatus['suppressions'] => ({ total: 0, bounced: 0, complaints: 0, unsubscribed: 0, byCategory: {} });
  for (const g of groups) {
    const owner = ownerOf.get(g.workspaceId);
    if (!owner) continue;
    const r = report.get(owner) ?? blank();
    const n = g._count._all;
    r.total += n;
    if (g.reason === 'BOUNCED') r.bounced += n; else if (g.reason === 'COMPLAINT') r.complaints += n; else r.unsubscribed += n;
    if (g.category) r.byCategory[g.category] = (r.byCategory[g.category] ?? 0) + n;
    report.set(owner, r);
  }
  return all.map((a) => {
    const readable = a.status === 'CONNECTED' && !!a.refreshTokenEnc;
    return {
      email: a.emailAddress,
      userId: a.userId,
      user: nameOf.get(a.userId) || a.emailAddress.split('@')[0]!,
      state: readable ? 'CONNECTED' : a.status === 'CONNECTED' ? 'NO ACCESS SAVED' : a.status,
      readable,
      lastSyncedAt: a.bounceScanAt ? a.bounceScanAt.toISOString() : null,
      notices: a.bounceScanNotices,
      error: a.bounceScanError,
      suppressions: report.get(a.userId) ?? blank(),
    };
  });
}
