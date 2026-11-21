import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { emailKey } from '@/lib/recruiterSend/emailKey';

/**
 * "Over-mailed recruiters" for the daily report: recruiters the Recruiter Bulk Send keeps skipping
 * because they were emailed too recently, i.e. they are being emailed too often or by too many people.
 *
 * Rule: over the last 30 days, among this organisation's sends (not follow-ups) that started in
 * that time, a person (one key per inbox, Gmail dots and +tags ignored) counts when skipped as
 * RECENTLY_EMAILED in at least 3 different sends. Rows from before skipKind existed count only when
 * their skipReason starts with "Emailed " or "Already in ". The top 10 are listed, `total` is how many
 * meet the rule. `coolOff` is how many different people were skipped for COOL_OFF in the last 7 days.
 */

export const OVERMAILED_DAYS = 30;
export const OVERMAILED_MIN_SENDS = 3;
export const OVERMAILED_LIMIT = 10;
export const OVERMAILED_FOOTER = 'These recruiters keep being emailed too soon. Consider removing them from lists or giving them a cool-off.';

export interface OvermailedPerson {
  email: string;
  skippedSends: number;
  lastSkippedAt: Date;
  sample: string;
}

export interface Overmailed {
  people: OvermailedPerson[];
  /** How many people meet the rule (may be more than the list shows). */
  total: number;
  /** Different people skipped for a "do not contact until" date in the last 7 days. */
  coolOff: number;
}

const DAY = 86_400_000;

export const overmailedVisible = (o: Overmailed | null | undefined): o is Overmailed => !!o && (o.total > 0 || o.coolOff > 0);

export async function collectOvermailed(organizationId: string, now: Date = new Date()): Promise<Overmailed> {
  const since = new Date(now.getTime() - OVERMAILED_DAYS * DAY);
  const coolSince = new Date(now.getTime() - 7 * DAY);

  const [rows, cool] = await Promise.all([
    prisma.$queryRaw<{ email: string; sends: bigint | number; lastAt: Date; reason: string | null; total: bigint | number }[]>(Prisma.sql`
      SELECT (array_agg(r."email" ORDER BY b."startedAt" DESC))[1] AS email,
             COUNT(DISTINCT r."blastId") AS sends,
             MAX(b."startedAt") AS "lastAt",
             (array_agg(r."skipReason" ORDER BY b."startedAt" DESC))[1] AS reason,
             COUNT(*) OVER () AS total
      FROM "RecruiterBlastRecipient" r
      JOIN "RecruiterBlast" b ON b."id" = r."blastId"
      WHERE r."status" = 'SKIPPED'
        AND b."organizationId" = ${organizationId}
        AND b."parentBlastId" IS NULL
        AND b."startedAt" >= ${since}
        AND (r."skipKind" = 'RECENTLY_EMAILED'
             OR (r."skipKind" IS NULL AND (r."skipReason" LIKE 'Emailed %' OR r."skipReason" LIKE 'Already in %')))
      GROUP BY mailflow_email_key(r."email")
      HAVING COUNT(DISTINCT r."blastId") >= ${OVERMAILED_MIN_SENDS}
      ORDER BY sends DESC, "lastAt" DESC
      LIMIT ${OVERMAILED_LIMIT}`),
    prisma.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT mailflow_email_key(r."email")) AS n
      FROM "RecruiterBlastRecipient" r
      JOIN "RecruiterBlast" b ON b."id" = r."blastId"
      WHERE r."status" = 'SKIPPED' AND r."skipKind" = 'COOL_OFF'
        AND b."organizationId" = ${organizationId}
        AND b."parentBlastId" IS NULL
        AND b."startedAt" >= ${coolSince}`),
  ]);

  // Safety net: the SQL already groups by the key, this keeps one row per person if a database
  // ever returns two spellings (and returns the totals as plain numbers).
  const seen = new Map<string, OvermailedPerson>();
  for (const r of rows) {
    const k = emailKey(r.email);
    const person: OvermailedPerson = {
      email: r.email,
      skippedSends: Number(r.sends),
      lastSkippedAt: new Date(r.lastAt),
      sample: (r.reason ?? '').slice(0, 120),
    };
    const prev = seen.get(k);
    if (!prev || prev.skippedSends < person.skippedSends) seen.set(k, person);
  }
  const people = [...seen.values()];
  return { people, total: rows.length ? Number(rows[0]!.total) : 0, coolOff: Number(cool[0]?.n ?? 0) };
}

/** Never lets this section stop a report: any failure means the section is left out. */
export async function collectOvermailedSafe(organizationId: string, now: Date = new Date()): Promise<Overmailed | null> {
  try {
    const o = await collectOvermailed(organizationId, now);
    return overmailedVisible(o) ? o : null;
  } catch {
    return null;
  }
}

/** "18 Nov" (India date). */
export function shortDay(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/** "name@company.com: skipped in 5 sends in 30 days (last 18 Nov)" */
export function overmailedLine(p: OvermailedPerson, maxEmail = 200): string {
  const email = p.email.length > maxEmail ? `${p.email.slice(0, maxEmail - 1)}…` : p.email;
  return `${email}: skipped in ${p.skippedSends} sends in ${OVERMAILED_DAYS} days (last ${shortDay(p.lastSkippedAt)})`;
}

export function coolOffLine(n: number): string {
  return `${n} ${n === 1 ? 'person was' : 'people were'} skipped for a cool-off date in the last 7 days.`;
}
