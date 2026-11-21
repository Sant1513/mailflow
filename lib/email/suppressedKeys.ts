import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { emailKey } from '@/lib/recruiterSend/emailKey';

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
  for (let i = 0; i < all.length; i += 1000) {
    const rows = await prisma.emailSuppression.findMany({ where: { workspaceId, email: { in: all.slice(i, i + 1000), mode: 'insensitive' } }, select: { email: true } });
    for (const r of rows) out.add(emailKey(r.email));
  }
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
