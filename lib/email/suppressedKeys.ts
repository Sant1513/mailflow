import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { emailKey } from '@/lib/recruiterSend/emailKey';

type Row = { email: string; reason: string; detail: string | null };

/**
 * The suppression rows for these addresses (any capitals), fast on a big list. The unique index serves the exact
 * (lower-case) lookup; a second lookup on lower(email) catches rows saved with capitals. Prisma's own
 * case-insensitive "in" cannot use an index and took over a minute on a 570,000-row table.
 */
export async function suppressionRows(workspaceId: string, emails: string[]): Promise<Row[]> {
  const lower = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const found = new Map<string, Row>();
  for (let i = 0; i < lower.length; i += 1000) {
    const chunk = lower.slice(i, i + 1000);
    for (const r of await prisma.emailSuppression.findMany({ where: { workspaceId, email: { in: chunk } }, select: { email: true, reason: true, detail: true } })) found.set(r.email.toLowerCase(), r);
    try {
      const more = await prisma.$queryRaw<Row[]>(Prisma.sql`SELECT "email", "reason", "detail" FROM "EmailSuppression" WHERE "workspaceId" = ${workspaceId} AND lower("email") = ANY(${chunk}::text[])`);
      for (const r of more) if (!found.has(r.email.toLowerCase())) found.set(r.email.toLowerCase(), r);
    } catch { /* the exact lookup above already answered */ }
  }
  return [...found.values()];
}

const isGmail = (e: string) => /@(gmail|googlemail)\.com$/i.test(e.trim());

/**
 * Which of these addresses are on a workspace's suppression list, counting the same inbox written two ways as one
 * (case, and for Gmail the dots and "+tag"). Returns the emailKey() of each suppressed address.
 * Used by the follow-up features so a suppressed person is never emailed again under a different spelling.
 */
export async function suppressedKeys(workspaceId: string, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const all = [...new Set(emails.map((e) => e.trim()).filter(Boolean))];
  // Exact address, any capitals.
  for (const r of await suppressionRows(workspaceId, all)) out.add(emailKey(r.email));
  // Gmail spells one inbox many ways: look those up by key in the database (mailflow_email_key).
  const gmailKeys = [...new Set(all.filter(isGmail).map(emailKey))];
  for (let i = 0; i < gmailKeys.length; i += 1000) {
    const chunk = gmailKeys.slice(i, i + 1000);
    const rows = await prisma.$queryRaw<{ email: string }[]>(Prisma.sql`
      SELECT "email" FROM "EmailSuppression"
      WHERE "workspaceId" = ${workspaceId} AND mailflow_email_key("email") = ANY(${chunk}::text[])`);
    for (const r of rows) out.add(emailKey(r.email));
  }
  return out;
}
