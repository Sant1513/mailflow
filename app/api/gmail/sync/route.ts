import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { syncAccount } from '@/lib/gmail/sync';
import { EmailProvider as EmailProviderEnum } from '@prisma/client';

/**
 * §104 "Sync Now". Pulls new inbound mail for the caller's connected
 * mailbox. This is the path that works with no Pub/Sub configured, and the
 * recovery path when push delivery has been missed.
 */
export const POST = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 });

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

  const result = await syncAccount(account);

  await audit(session, 'GMAIL_SYNC', {
    targetType: 'EmailProviderAccount',
    targetId: account.id,
    metadata: { path: result.path, fetched: result.fetched, stored: result.stored, errors: result.errors.length },
  });

  return NextResponse.json({
    ...result,
    note:
      result.errors.length > 0
        ? `${result.stored} new message(s) stored; ${result.errors.length} could not be processed.`
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
