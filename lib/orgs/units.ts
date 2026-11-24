import { Role } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { audit } from '@/lib/audit/log';
import { assertSeatAvailable } from '@/lib/orgs/seats';
import { ForbiddenError, type AppSession } from '@/lib/auth/session';
import { accessOf, newValidUntil, type AccessState, type LockLevel } from '@/lib/orgs/lifecycle';

/**
 * Organisations (teams / business units) inside the company: Operations, HR, Tech, Curriculum, a separate brand such as
 * Neev Labs… Every user belongs to exactly one, assigned by a Super Admin when approving the sign-up and changeable later.
 *
 * What the organisation controls:
 *   - which mailboxes a send may use: a send is made "as" one organisation and can use only mailboxes owned by that
 *     organisation's members (and, when the organisation lists sender domains, only addresses on those domains);
 *   - what an Admin sees: an Admin sees their own organisation's sends and recruiters, a Super Admin sees every organisation.
 * What it deliberately does NOT split: suppression lists (a bounce or unsubscribe blocks the address for every team) and the
 * "emailed recently" guard (two teams must not email the same recruiter the same week).
 */

export const domainOf = (email: string): string => (email.split('@')[1] ?? '').trim().toLowerCase();

/** Normalises a typed list of domains ("@Masaischool.com, neevlabs.ai") to lower-case, unique, without "@". */
export function parseDomains(input: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(input) ? input : (input ?? '').split(/[\s,;]+/);
  const out = parts.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter((d) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));
  return [...new Set(out)];
}

/** May this mailbox address send for an organisation with these sender domains? (No domains listed = any domain.) */
export function domainAllowed(orgDomains: readonly string[], mailboxEmail: string): boolean {
  if (!orgDomains.length) return true;
  return orgDomains.includes(domainOf(mailboxEmail));
}

export interface OrgUnitRow {
  id: string;
  name: string;
  domains: string[];
  /** ACTIVE | DISABLED (the switch a Super Admin flips). */
  status: string;
  /** The derived state: ACTIVE | EXPIRING | GRACE | EXPIRED | DISABLED (lib/orgs/lifecycle.ts). */
  state: AccessState;
  lock: LockLevel;
  daysLeft: number | null;
  validUntil: string | null;
  locksAt: string | null;
  graceDays: number;
  seatLimit: number | null;
  /** People using a seat: ACTIVE users (pending sign-ups do not count). */
  seatsUsed: number;
  billingNote: string | null;
  /** Everyone who is not disabled (active + pending) assigned to it. */
  members: number;
  mailboxes: number;
}

/** The ACTIVE people in each organisation (the seats in use). */
export async function activeSeatCounts(organizationId: string): Promise<Map<string | null, number>> {
  const rows = await prisma.user.groupBy({ by: ['orgUnitId'], where: { organizationId, orgUnitId: { not: null }, status: 'ACTIVE' }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.orgUnitId, r._count._all]));
}

export async function listOrgUnits(organizationId: string, now: Date = new Date()): Promise<OrgUnitRow[]> {
  const units = await prisma.orgUnit.findMany({
    where: { organizationId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, domains: true, status: true, seatLimit: true, validUntil: true, graceDays: true, billingNote: true },
  });
  if (!units.length) return [];
  const [members, seats, mailboxes] = await Promise.all([
    prisma.user.groupBy({ by: ['orgUnitId'], where: { organizationId, orgUnitId: { not: null }, status: { not: 'DISABLED' } }, _count: { _all: true } }),
    activeSeatCounts(organizationId),
    prisma.emailProviderAccount.findMany({ where: { organizationId, status: 'CONNECTED' }, select: { user: { select: { orgUnitId: true } } } }),
  ]);
  const memberCount = new Map(members.map((m) => [m.orgUnitId, m._count._all]));
  const boxCount = new Map<string | null, number>();
  for (const b of mailboxes) boxCount.set(b.user.orgUnitId, (boxCount.get(b.user.orgUnitId) ?? 0) + 1);
  return units.map((u) => {
    const a = accessOf(u, now);
    return {
      id: u.id,
      name: u.name,
      domains: u.domains,
      status: u.status,
      state: a.state,
      lock: a.lock,
      daysLeft: a.daysLeft,
      validUntil: u.validUntil ? u.validUntil.toISOString() : null,
      locksAt: a.locksAt ? a.locksAt.toISOString() : null,
      graceDays: u.graceDays,
      seatLimit: u.seatLimit,
      seatsUsed: seats.get(u.id) ?? 0,
      billingNote: u.billingNote,
      members: memberCount.get(u.id) ?? 0,
      mailboxes: boxCount.get(u.id) ?? 0,
    };
  });
}

/** The organisation a domain points at, when exactly one organisation lists it (used to suggest one when approving). */
export function suggestOrgFor(email: string, units: { id: string; domains: string[] }[]): string | null {
  const d = domainOf(email);
  const hits = units.filter((u) => u.domains.includes(d));
  return hits.length === 1 ? hits[0]!.id : null;
}

/**
 * The organisation a send is made as. Anyone may send as their own organisation; only a Super Admin may pick another one
 * (to send on behalf of a team). `requested` null/undefined means the caller's own.
 */
export async function resolveSendOrg(session: Pick<AppSession, 'organizationId' | 'role' | 'orgUnitId'>, requested?: string | null): Promise<{ id: string; name: string; domains: string[] }> {
  const id = requested || session.orgUnitId;
  if (!id) throw new ForbiddenError('Your account has no organisation yet. Ask a Super Admin to assign one.');
  if (id !== session.orgUnitId && session.role !== Role.SUPER_ADMIN) throw new ForbiddenError('You can only send as your own organisation.');
  const unit = await prisma.orgUnit.findFirst({ where: { id, organizationId: session.organizationId }, select: { id: true, name: true, domains: true } });
  if (!unit) throw new ForbiddenError('That organisation does not exist.');
  return unit;
}

/** The organisation an existing send belongs to: the one it was made as, else its creator's (sends made before organisations existed). */
export async function orgOfSend(send: { orgUnitId?: string | null; createdById?: string | null }): Promise<string | null> {
  if (send.orgUnitId) return send.orgUnitId;
  if (!send.createdById) return null;
  return (await prisma.user.findUnique({ where: { id: send.createdById }, select: { orgUnitId: true } }))?.orgUnitId ?? null;
}

/**
 * Why a mailbox may NOT send for an organisation, or null when it may: its owner must be a member of the organisation, and
 * its address must be on the organisation's sender domains when it lists any. This is the guard that stops, for example,
 * a Neev Labs mailbox from sending a Masai School email.
 */
export async function senderOrgProblem(account: { userId: string; emailAddress: string }, orgUnitId: string | null | undefined): Promise<string | null> {
  if (!orgUnitId) return 'This send has no organisation. Choose the organisation it is sent as.';
  const [unit, owner] = await Promise.all([
    prisma.orgUnit.findUnique({ where: { id: orgUnitId }, select: { name: true, domains: true } }),
    prisma.user.findUnique({ where: { id: account.userId }, select: { orgUnitId: true, orgUnit: { select: { name: true } } } }),
  ]);
  if (!unit) return 'That organisation no longer exists.';
  if (owner?.orgUnitId !== orgUnitId) return `${account.emailAddress} belongs to ${owner?.orgUnit?.name ?? 'no organisation'}, not ${unit.name}. A send can only use ${unit.name}'s own mailboxes.`;
  if (!domainAllowed(unit.domains, account.emailAddress)) return `${account.emailAddress} is not on ${unit.name}'s sender domains (${unit.domains.map((d) => '@' + d).join(', ')}).`;
  return null;
}

/** The organisations a person may send as: their own, or every one for a Super Admin. */
export async function sendableOrgs(session: Pick<AppSession, 'organizationId' | 'role' | 'orgUnitId'>): Promise<{ id: string; name: string }[]> {
  const where = session.role === Role.SUPER_ADMIN ? { organizationId: session.organizationId } : { organizationId: session.organizationId, id: session.orgUnitId ?? '' };
  return prisma.orgUnit.findMany({ where, orderBy: { name: 'asc' }, select: { id: true, name: true } });
}

/** A refusal that is the Super Admin's to read (shown as is): the status is the HTTP status the API answers with. */
export type OrgRuleResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface OrgLifecycleInput {
  /** Most ACTIVE people (null = unlimited). */
  seatLimit?: number | null;
  /** Fixed end date, "YYYY-MM-DD" India time (null clears the expiry). */
  validUntil?: string | null;
  /** Or: valid for this many days from today. */
  validDays?: number;
  graceDays?: number;
  billingNote?: string | null;
}

/** Turns the typed validity into a date, or explains what is wrong. undefined = leave as it is. */
function validityFrom(input: OrgLifecycleInput, current: Date | null, now: Date): OrgRuleResult<Date | null | undefined> {
  if (input.validDays !== undefined) {
    const d = newValidUntil({ mode: 'days', days: input.validDays }, current, now);
    return d ? { ok: true, value: d } : { ok: false, status: 400, error: 'Days must be a whole number from 1 to 3650.' };
  }
  if (input.validUntil === null) return { ok: true, value: null };
  if (input.validUntil !== undefined) {
    const d = newValidUntil({ mode: 'until', until: input.validUntil }, null, now);
    return d ? { ok: true, value: d } : { ok: false, status: 400, error: 'Choose a valid date in the future (YYYY-MM-DD).' };
  }
  return { ok: true, value: undefined };
}

export async function createOrgUnit(session: AppSession, input: { name: string; domains?: string[] } & OrgLifecycleInput) {
  const name = input.name.trim();
  const validity = validityFrom(input, null, new Date());
  if (!validity.ok) return validity;
  if (input.seatLimit !== undefined && input.seatLimit !== null && (!Number.isInteger(input.seatLimit) || input.seatLimit < 1 || input.seatLimit > 100000)) {
    return { ok: false as const, status: 400, error: 'The seat limit must be a whole number from 1 up (or blank for unlimited).' };
  }
  const unit = await prisma.orgUnit.create({
    data: {
      organizationId: session.organizationId,
      name,
      domains: parseDomains(input.domains ?? []),
      seatLimit: input.seatLimit ?? null,
      validUntil: validity.value ?? null,
      graceDays: input.graceDays ?? 0,
      billingNote: input.billingNote?.trim() || null,
    },
  });
  await audit(session, 'ORG_UNIT_CREATE', { targetType: 'OrgUnit', targetId: unit.id, metadata: { name, domains: unit.domains, seatLimit: unit.seatLimit, validUntil: unit.validUntil, graceDays: unit.graceDays } });
  return { ok: true as const, value: unit };
}

/**
 * Edits an organisation: its name, sender domains, enabled / disabled, seat limit, validity (end date), grace days and note.
 * Lowering the seat limit below the people already active is refused with the numbers (disable or move someone first).
 * Returns null when the organisation is not in the company.
 */
export async function updateOrgUnit(
  session: AppSession,
  id: string,
  input: { name?: string; domains?: string[]; status?: 'ACTIVE' | 'DISABLED' } & OrgLifecycleInput,
  now: Date = new Date(),
): Promise<OrgRuleResult<NonNullable<Awaited<ReturnType<typeof prisma.orgUnit.update>>>> | null> {
  const current = await prisma.orgUnit.findFirst({ where: { id, organizationId: session.organizationId } });
  if (!current) return null;

  if (input.seatLimit !== undefined && input.seatLimit !== null) {
    if (!Number.isInteger(input.seatLimit) || input.seatLimit < 1 || input.seatLimit > 100000) return { ok: false, status: 400, error: 'The seat limit must be a whole number from 1 up (or blank for unlimited).' };
    const used = (await activeSeatCounts(session.organizationId)).get(id) ?? 0;
    if (used > input.seatLimit) {
      return { ok: false, status: 409, error: `${used} ${used === 1 ? 'person is' : 'people are'} active in ${current.name}, so the limit cannot be ${input.seatLimit}. Disable or move ${used - input.seatLimit} ${used - input.seatLimit === 1 ? 'person' : 'people'} first.` };
    }
  }
  if (input.graceDays !== undefined && (!Number.isInteger(input.graceDays) || input.graceDays < 0 || input.graceDays > 30)) return { ok: false, status: 400, error: 'Grace days must be a whole number from 0 to 30.' };
  const validity = validityFrom(input, current.validUntil, now);
  if (!validity.ok) return validity;

  const unit = await prisma.orgUnit.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.domains !== undefined ? { domains: parseDomains(input.domains) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.seatLimit !== undefined ? { seatLimit: input.seatLimit } : {}),
      ...(validity.value !== undefined ? { validUntil: validity.value, lastReminderDays: null } : {}),
      ...(input.graceDays !== undefined ? { graceDays: input.graceDays } : {}),
      ...(input.billingNote !== undefined ? { billingNote: input.billingNote?.trim() || null } : {}),
    },
  });
  const changed = { name: [current.name, unit.name], domains: [current.domains, unit.domains], status: [current.status, unit.status], seatLimit: [current.seatLimit, unit.seatLimit], validUntil: [current.validUntil, unit.validUntil], graceDays: [current.graceDays, unit.graceDays] } as const;
  const diff = Object.fromEntries(Object.entries(changed).filter(([, [a, b]]) => JSON.stringify(a) !== JSON.stringify(b)));
  await audit(session, current.status !== unit.status ? (unit.status === 'DISABLED' ? 'ORG_DISABLE' : 'ORG_ENABLE') : 'ORG_UNIT_UPDATE', { targetType: 'OrgUnit', targetId: id, metadata: { name: unit.name, changes: diff } });
  return { ok: true, value: unit };
}

/** Only an organisation nobody belongs to can be removed. */
export async function deleteOrgUnit(session: AppSession, id: string): Promise<'ok' | 'not_found' | 'has_members'> {
  const unit = await prisma.orgUnit.findFirst({ where: { id, organizationId: session.organizationId } });
  if (!unit) return 'not_found';
  if ((await prisma.user.count({ where: { orgUnitId: id } })) > 0) return 'has_members';
  await prisma.orgUnit.delete({ where: { id } });
  await audit(session, 'ORG_UNIT_DELETE', { targetType: 'OrgUnit', targetId: id, metadata: { name: unit.name } });
  return 'ok';
}

/**
 * Puts a user (and their workspace) in an organisation: the Super Admin's choice when approving, and when changing it later.
 * Their past sends keep the organisation they were made as. Returns null when the user or organisation is not in the company.
 */
export async function assignUserToOrg(session: AppSession, userId: string, orgUnitId: string) {
  const [user, unit] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, organizationId: session.organizationId }, select: { id: true, email: true, orgUnitId: true, status: true } }),
    prisma.orgUnit.findFirst({ where: { id: orgUnitId, organizationId: session.organizationId }, select: { id: true, name: true } }),
  ]);
  if (!user || !unit) return null;
  if (user.orgUnitId === unit.id) return { changed: false, unit };
  // An active person takes a seat in the organisation they move into.
  if (user.status === 'ACTIVE') await assertSeatAvailable(unit.id, user.id);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { orgUnitId: unit.id } }),
    prisma.workspace.updateMany({ where: { ownerId: user.id }, data: { orgUnitId: unit.id } }),
  ]);
  await audit(session, user.orgUnitId ? 'USER_ORG_CHANGE' : 'USER_ORG_ASSIGN', { targetType: 'User', targetId: user.id, metadata: { email: user.email, from: user.orgUnitId, to: unit.id, toName: unit.name } });
  return { changed: true, unit };
}
