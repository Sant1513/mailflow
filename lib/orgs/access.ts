import { prisma } from '@/lib/db/client';
import { accessMessage, accessOf, type OrgAccess } from '@/lib/orgs/lifecycle';

/**
 * Whether an organisation may use MailFlow right now (spec: docs/org-lifecycle.md). Worked out from its status, end date and grace
 * days, cached for a minute so the check on every request costs nothing. A person with no organisation is never locked here.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; org: { name: string; access: OrgAccess } | null }>();

/** Test hook / after a Super Admin changes an organisation: forget what was cached. */
export function resetOrgAccessCache(orgUnitId?: string): void {
  if (orgUnitId) cache.delete(orgUnitId);
  else cache.clear();
}

export interface OrgAccessInfo { name: string; access: OrgAccess }

/** The organisation's name and access, or null when it does not exist (then nothing is locked: nothing to lock). */
export async function getOrgAccess(orgUnitId: string | null | undefined, now: Date = new Date()): Promise<OrgAccessInfo | null> {
  if (!orgUnitId) return null;
  const hit = cache.get(orgUnitId);
  if (hit && now.getTime() - hit.at < TTL_MS) {
    return hit.org ? { name: hit.org.name, access: hit.org.access } : null;
  }
  const row = await prisma.orgUnit.findUnique({ where: { id: orgUnitId }, select: { name: true, status: true, validUntil: true, graceDays: true } });
  const org = row ? { name: row.name, access: accessOf(row, now) } : null;
  cache.set(orgUnitId, { at: now.getTime(), org });
  return org;
}

/** Is this organisation locked (EXPIRED: dashboard only, DISABLED: nothing)? GRACE and EXPIRING are not locked. */
export async function isOrgLocked(orgUnitId: string | null | undefined): Promise<boolean> {
  const info = await getOrgAccess(orgUnitId);
  return !!info && info.access.lock !== 'none';
}

export type OrgLockCode = 'ORG_DISABLED' | 'ORG_EXPIRED';

/** The lock for an organisation as a code and a message for people, or null when it is open. */
export async function orgLockOf(orgUnitId: string | null | undefined): Promise<{ code: OrgLockCode; message: string; lock: 'dashboard' | 'full'; orgName: string } | null> {
  const info = await getOrgAccess(orgUnitId);
  if (!info || info.access.lock === 'none') return null;
  const msg = accessMessage(info.access, info.name);
  return {
    code: info.access.state === 'DISABLED' ? 'ORG_DISABLED' : 'ORG_EXPIRED',
    message: msg ? `${msg.title}. ${msg.body}` : `${info.name} is locked.`,
    lock: info.access.lock,
    orgName: info.name,
  };
}

/** For a session: Super Admins are never locked; everyone else follows their organisation. */
export async function orgAccessOfSession(session: { role: string; orgUnitId?: string | null }): Promise<OrgAccessInfo | null> {
  if (session.role === 'SUPER_ADMIN') return null;
  return getOrgAccess(session.orgUnitId);
}

/** Why a send (campaign, Quick Send, recruiter send, job) of this organisation may not go out right now, or null. */
export async function sendLockReason(orgUnitId: string | null | undefined): Promise<string | null> {
  const lock = await orgLockOf(orgUnitId);
  if (!lock) return null;
  return lock.code === 'ORG_DISABLED' ? `Paused: ${lock.orgName} is disabled` : `Paused: ${lock.orgName}’s access has expired`;
}

/**
 * Why a send (a campaign, a recruiter send, an email job) may not go out now: its organisation is the one it was made as, else its
 * creator's. A failed lookup never blocks sending (a database that cannot answer cannot send either, and a lock must never be
 * the reason an unrelated send fails).
 */
export async function sendLockReasonOf(send: { orgUnitId?: string | null; createdById?: string | null }): Promise<string | null> {
  try {
    let orgUnitId = send.orgUnitId ?? null;
    if (!orgUnitId && send.createdById) {
      orgUnitId = (await prisma.user.findUnique({ where: { id: send.createdById }, select: { orgUnitId: true } }))?.orgUnitId ?? null;
    }
    return await sendLockReason(orgUnitId);
  } catch {
    return null;
  }
}
