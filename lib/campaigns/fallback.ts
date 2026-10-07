import { EmailProvider as EmailProviderEnum } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getOrgSettings, updateOrgSettings } from '@/lib/settings/org';

/**
 * Fallback sender mailboxes. When a campaign's mailbox can't send right now
 * (Google's daily limit, a Gmail "slow down" back-off, or it was
 * disconnected), the next emails go out from the campaign's backup mailboxes,
 * in order. A mailbox can be a backup only if its owner opted in (Settings),
 * because the email goes out under that person's address.
 */

export interface MailboxOption {
  id: string;
  emailAddress: string;
  ownerName: string;
  status: string;
}

export async function fallbackOptIns(organizationId: string): Promise<Set<string>> {
  return new Set((await getOrgSettings(organizationId)).fallbackMailboxes);
}

/** The caller's own connected Gmail (their home workspace first). */
export async function ownMailbox(userId: string) {
  return prisma.emailProviderAccount.findFirst({
    where: { userId, provider: EmailProviderEnum.GMAIL },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
  });
}

export async function setFallbackOptIn(organizationId: string, accountId: string, allow: boolean, userId: string): Promise<void> {
  const current = await fallbackOptIns(organizationId);
  if (allow) current.add(accountId);
  else current.delete(accountId);
  await updateOrgSettings(organizationId, { fallbackMailboxes: [...current] }, userId);
}

/** Mailboxes that can be added as a backup: connected, opted in, in this organisation. */
export async function availableFallbackMailboxes(organizationId: string, excludeAccountId?: string | null): Promise<MailboxOption[]> {
  const optIns = await fallbackOptIns(organizationId);
  if (!optIns.size) return [];
  const accounts = await prisma.emailProviderAccount.findMany({
    where: { id: { in: [...optIns] }, organizationId, provider: EmailProviderEnum.GMAIL },
    select: { id: true, emailAddress: true, status: true, user: { select: { name: true, status: true } } },
    orderBy: { emailAddress: 'asc' },
  });
  return accounts
    .filter((a) => a.id !== excludeAccountId && a.user.status === 'ACTIVE')
    .map((a) => ({ id: a.id, emailAddress: a.emailAddress, ownerName: a.user.name, status: a.status }));
}

/**
 * Validates a campaign's backup list: unique, not the main sender, each one
 * opted in and in the organisation. Returns the cleaned list or an error.
 */
export async function validateFallbackList(
  organizationId: string,
  mainAccountId: string | null,
  ids: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const unique = [...new Set(ids)].filter((id) => id && id !== mainAccountId);
  if (unique.length > 5) return { ok: false, error: 'At most 5 backup mailboxes.' };
  if (!unique.length) return { ok: true, ids: [] };
  const allowed = new Map((await availableFallbackMailboxes(organizationId, mainAccountId)).map((m) => [m.id, m]));
  const bad = unique.find((id) => !allowed.has(id));
  if (bad) return { ok: false, error: 'A chosen mailbox is not available as a backup (its owner has not allowed it, or it left the organisation).' };
  return { ok: true, ids: unique };
}

export type HoldReason = 'daily_limit' | 'backoff' | 'disconnected';

export function holdReasonText(reason: HoldReason): string {
  return reason === 'daily_limit'
    ? "reached today's sending limit"
    : reason === 'backoff'
      ? 'was asked by Gmail to slow down'
      : 'is disconnected';
}
