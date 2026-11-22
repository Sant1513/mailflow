import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ForbiddenError, isSuperAdmin, requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { prisma } from '@/lib/db/client';
import { runBounceScan } from '@/lib/email/bounceScan';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const Body = z.object({ mailbox: z.string().email() });

/**
 * "Sync now" for ONE mailbox (super admin only). The page calls this once per mailbox, one after another, so it can show
 * progress; when `more` comes back true the page calls again and the scan continues where it stopped.
 * Same scan as the 15-minute job (lib/email/bounceScan.ts): safe to repeat.
 */
export const POST = withErrorHandling(async (req: Request) => {
  const session = await requireSession();
  if (!isSuperAdmin(session)) throw new ForbiddenError('Only a super admin can run the sync');
  const { mailbox } = Body.parse(await req.json());
  const account = await prisma.emailProviderAccount.findFirst({
    where: { organizationId: session.organizationId, emailAddress: { equals: mailbox, mode: 'insensitive' } },
    select: { emailAddress: true },
  });
  if (!account) return NextResponse.json({ error: 'That mailbox is not in your organisation' }, { status: 404 });
  const summary = await runBounceScan({ budgetMs: 50_000, onlyMailbox: account.emailAddress });
  const r = summary.mailboxes[0];
  if (!r) return NextResponse.json({ ok: false, error: 'This mailbox cannot be read (disconnected or no access saved).', more: false, notices: 0, suppressed: 0 });
  return NextResponse.json({ ok: r.ok, error: r.error ?? null, more: r.more, notices: r.notices, suppressed: r.suppressed, errors: r.errors });
});
