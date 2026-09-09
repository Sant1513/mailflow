import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { syncAccountToCompletion } from '@/lib/gmail/sync';

// Busy mailboxes need more than the 10s default; the sync loop budgets itself under this.
export const maxDuration = 60;
import { EmailProvider as EmailProviderEnum } from '@prisma/client';

/**
 * §104 "Sync Now". Pulls new inbound mail for the caller's connected
 * mailbox. This is the path that works with no Pub/Sub configured, and the
 * recovery path when push delivery has been missed.
 */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 });
  // Pages call this on open with ?ifStaleMinutes=2 so a mailbox synced a
  // moment ago is not hammered; Sync Now sends no guard.
  const staleMinutes = Number(new URL(req.url).searchParams.get('ifStaleMinutes') ?? '0');

  const account = await prisma.emailProviderAccount.findUnique({
    where: {
      workspaceId_userId_provider: {
        workspaceId: session.workspaceId,
        userId: session.userId,
        provider: EmailProviderEnum.GMAIL,
      },
    },
  });

  if (!account || account.status !== 'CONNECTED' || !account.refreshTokenEnc) {
    return NextResponse.json(
      { error: 'Connect your Gmail account in Settings before syncing.' },
      { status: 400 }
    );
  }

  if (staleMinutes > 0 && account.lastSyncAt && Date.now() - account.lastSyncAt.getTime() < staleMinutes * 60_000) {
    return NextResponse.json({ skipped: true, lastSyncAt: account.lastSyncAt, stored: 0, note: 'Synced recently.' });
  }

  const result = await syncAccountToCompletion(account, { totalBudgetMs: 45_000 });

  await audit(session, 'GMAIL_SYNC', {
    targetType: 'EmailProviderAccount',
    targetId: account.id,
    metadata: { path: result.path, listed: result.listed, fetched: result.fetched, stored: result.stored, remaining: result.remaining, rounds: result.rounds, elapsedMs: result.elapsedMs, errors: result.errors.length },
  });

  return NextResponse.json({
    ...result,
    note:
      result.errors.length > 0
        ? `${result.stored} new message(s) stored; ${result.errors.length} could not be processed.`
        : result.remaining > 0
          ? `${result.stored} new message(s) stored; ${result.remaining} more to check — sync again.`
          : result.stored > 0
            ? `${result.stored} new message(s) stored.`
            : 'Nothing new.',
  });
});

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ account: null });

  const account = await prisma.emailProviderAccount.findUnique({
    where: {
      workspaceId_userId_provider: {
        workspaceId: session.workspaceId,
        userId: session.userId,
        provider: EmailProviderEnum.GMAIL,
      },
    },
    select: { emailAddress: true, status: true, gmailHistoryId: true, lastVerifiedAt: true, watchExpiresAt: true },
  });

  return NextResponse.json({
    account,
    pushConfigured: !!process.env.GMAIL_PUBSUB_TOPIC,
  });
});
