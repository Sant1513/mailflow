import { unstable_cache } from 'next/cache';
import { prisma } from '@/lib/db/client';
import { roundDown, type RoundedStat } from './format';

/**
 * Live, real totals for the public landing page. Server-only (it reads the database).
 *
 * - Only organisation-wide counts: no names, addresses or per-person numbers.
 * - Cheap count() queries, cached for a day (unstable_cache, revalidate 86400), so the public
 *   page costs about one round of queries a day however many people open it.
 * - Rounded down for display; a stat whose query fails (or is 0) is left out, never faked.
 *
 * Sources:
 * - emailsSent: EmailJob SENT (campaigns, Quick Send and automations all send through EmailJob)
 *   + RecruiterBlastRecipient SENT (Recruiter Bulk Send). Inbox replies are left out on
 *   purpose: campaign sends are also stored as OUTBOUND ConversationMessages, and nothing
 *   cheap tells the two apart, so adding them would double count.
 * - signaturesCollected: SigningRequest SIGNED (one row per signer).
 * - mailboxesConnected: EmailProviderAccount with status CONNECTED.
 * - repliesThreaded: INBOUND ConversationMessage, minus bounces and delivery failures.
 */
export type PublicStatKey = 'emailsSent' | 'signaturesCollected' | 'repliesThreaded' | 'mailboxesConnected';
export type PublicStat = RoundedStat & { key: PublicStatKey; label: string };

const LABELS: Record<PublicStatKey, string> = {
  emailsSent: 'emails sent',
  repliesThreaded: 'replies threaded',
  signaturesCollected: 'signatures collected',
  mailboxesConnected: 'mailboxes connected',
};

const ORDER: PublicStatKey[] = ['emailsSent', 'repliesThreaded', 'signaturesCollected', 'mailboxesConnected'];

async function settle(fn: () => Promise<number>): Promise<number | null> {
  try {
    const n = await fn();
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch (err) {
    console.error('[marketing] public stat query failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Uncached: runs the counts. Exported for tests; pages use getPublicStats(). */
export async function loadPublicStats(): Promise<PublicStat[]> {
  const [jobs, recruiters, signed, mailboxes, replies] = await Promise.all([
    settle(() => prisma.emailJob.count({ where: { status: 'SENT' } })),
    settle(() => prisma.recruiterBlastRecipient.count({ where: { status: 'SENT' } })),
    settle(() => prisma.signingRequest.count({ where: { status: 'SIGNED' } })),
    settle(() => prisma.emailProviderAccount.count({ where: { status: 'CONNECTED' } })),
    settle(() =>
      prisma.conversationMessage.count({
        where: { direction: 'INBOUND', classification: { notIn: ['BOUNCE', 'DELIVERY_FAILURE'] } },
      }),
    ),
  ]);

  // Every query failed: the database is unreachable. Throw so this result is not cached for a day.
  if ([jobs, recruiters, signed, mailboxes, replies].every((n) => n === null)) {
    throw new Error('public stats unavailable');
  }

  const raw: Record<PublicStatKey, number | null> = {
    // A partial sum would understate silently, so either part failing hides the total.
    emailsSent: jobs === null || recruiters === null ? null : jobs + recruiters,
    repliesThreaded: replies,
    signaturesCollected: signed,
    mailboxesConnected: mailboxes,
  };

  const out: PublicStat[] = [];
  for (const key of ORDER) {
    const n = raw[key];
    const rounded = n === null ? null : roundDown(n);
    if (rounded) out.push({ key, label: LABELS[key], ...rounded });
  }
  return out;
}

const cachedStats = unstable_cache(loadPublicStats, ['marketing-public-stats-v2'], { revalidate: 86_400 });

/** Cached once a day. Never throws: with no database the strip is simply hidden. */
export async function getPublicStats(): Promise<PublicStat[]> {
  try {
    return await cachedStats();
  } catch {
    return [];
  }
}
