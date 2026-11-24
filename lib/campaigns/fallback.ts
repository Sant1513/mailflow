import { EmailProvider as EmailProviderEnum } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getOrgSettings, updateOrgSettings } from '@/lib/settings/org';
import { domainAllowed } from '@/lib/orgs/units';

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

/**
 * Which organisation a send is made as, and the sender domains it lists. A send may use ONLY mailboxes owned by that
 * organisation's members (and on those domains when listed): this is the rule that stops one team's or brand's
 * mailboxes from sending another's email. It has no "any organisation" setting on purpose.
 */
export interface OrgScope {
  orgUnitId: string;
  domains: readonly string[];
}

export async function loadOrgScope(orgUnitId: string | null | undefined): Promise<OrgScope | null> {
  if (!orgUnitId) return null;
  const unit = await prisma.orgUnit.findUnique({ where: { id: orgUnitId }, select: { id: true, domains: true } });
  return unit ? { orgUnitId: unit.id, domains: unit.domains } : null;
}

export async function fallbackOptIns(organizationId: string): Promise<Set<string>> {
  return new Set((await getOrgSettings(organizationId)).fallbackMailboxes);
}

/** The caller's own Gmail, only if it may send for this organisation (the owner is a member and the domain is allowed). */
export async function ownMailboxIn(userId: string, scope: OrgScope | null) {
  if (!scope) return null;
  const mailbox = await ownMailbox(userId);
  if (!mailbox) return null;
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { orgUnitId: true } });
  if (owner?.orgUnitId !== scope.orgUnitId || !domainAllowed(scope.domains, mailbox.emailAddress)) return null;
  return mailbox;
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

/** Mailboxes that can be added as a backup: connected, opted in, owned by a member of THIS organisation, on its domains. */
export async function availableFallbackMailboxes(organizationId: string, excludeAccountId: string | null | undefined, scope: OrgScope | null): Promise<MailboxOption[]> {
  if (!scope) return [];
  const optIns = await fallbackOptIns(organizationId);
  if (!optIns.size) return [];
  const accounts = await prisma.emailProviderAccount.findMany({
    where: { id: { in: [...optIns] }, organizationId, provider: EmailProviderEnum.GMAIL, user: { orgUnitId: scope.orgUnitId } },
    select: { id: true, emailAddress: true, status: true, user: { select: { name: true, status: true } } },
    orderBy: { emailAddress: 'asc' },
  });
  return accounts
    .filter((a) => a.id !== excludeAccountId && a.user.status === 'ACTIVE' && domainAllowed(scope.domains, a.emailAddress))
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
  scope: OrgScope | null,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const unique = [...new Set(ids)].filter((id) => id && id !== mainAccountId);
  if (unique.length > 5) return { ok: false, error: 'At most 5 backup mailboxes.' };
  if (!unique.length) return { ok: true, ids: [] };
  const allowed = new Map((await availableFallbackMailboxes(organizationId, mainAccountId, scope)).map((m) => [m.id, m]));
  const bad = unique.find((id) => !allowed.has(id));
  if (bad) return { ok: false, error: 'A chosen mailbox is not available as a backup: its owner has not allowed it, or it belongs to another organisation, or it is on a domain this organisation does not send from.' };
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
