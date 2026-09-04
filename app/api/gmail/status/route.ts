import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { EmailProvider as EmailProviderEnum } from '@prisma/client';

/** §29 Settings → Gmail panel state. Never exposes tokens (§97). */
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
    // Explicit select: token columns must never reach the browser.
    select: {
      id: true,
      emailAddress: true,
      displayName: true,
      status: true,
      lastVerifiedAt: true,
      createdAt: true,
      scope: true,
    },
  });

  return NextResponse.json({ account });
});

export const DELETE = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) return NextResponse.json({ ok: true });

  const account = await prisma.emailProviderAccount.findUnique({
    where: {
      workspaceId_userId_provider: {
        workspaceId: session.workspaceId,
        userId: session.userId,
        provider: EmailProviderEnum.GMAIL,
      },
    },
  });
  if (!account) return NextResponse.json({ ok: true });

  // Clear the tokens rather than deleting the row: historical EmailJobs
  // reference it as the sender snapshot (§30), and that must survive.
  await prisma.emailProviderAccount.update({
    where: { id: account.id },
    data: { accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null, status: 'DISCONNECTED' },
  });

  await audit(session, 'GMAIL_DISCONNECTED', {
    targetType: 'EmailProviderAccount',
    targetId: account.id,
    metadata: { emailAddress: account.emailAddress },
  });

  return NextResponse.json({ ok: true });
});
