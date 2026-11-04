import { NextResponse } from 'next/server';
import { EmailProvider as EmailProviderEnum } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { hasScope, PHOTOS_OAUTH_SCOPE } from '@/lib/gmail/oauth';
import { syncProfilePhotos } from '@/lib/profilePhotos/sync';

/**
 * Settings → Gmail → Profile photos: whether your mailbox allows them, how many photos the
 * organization has, and when yours were last read (GET); read them again now (POST).
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function myMailbox(session: { workspaceId: string | null; userId: string }) {
  if (!session.workspaceId) return null;
  return prisma.emailProviderAccount.findUnique({
    where: { workspaceId_userId_provider: { workspaceId: session.workspaceId, userId: session.userId, provider: EmailProviderEnum.GMAIL } },
  });
}

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const [account, total, mailboxesOn] = await Promise.all([
    myMailbox(session),
    prisma.profilePhoto.count({ where: { organizationId: session.organizationId } }),
    prisma.emailProviderAccount.count({ where: { organizationId: session.organizationId, status: 'CONNECTED', scope: { contains: PHOTOS_OAUTH_SCOPE } } }),
  ]);
  return NextResponse.json({
    connected: account?.status === 'CONNECTED',
    enabled: !!account && hasScope(account, PHOTOS_OAUTH_SCOPE),
    lastReadAt: account?.photosSyncedAt ?? null,
    mine: account ? await prisma.profilePhoto.count({ where: { accountId: account.id } }) : 0,
    total,
    mailboxesOn,
  });
});

export const POST = withErrorHandling(async () => {
  const session = await requireSession();
  const account = await myMailbox(session);
  if (!account || account.status !== 'CONNECTED') return NextResponse.json({ error: 'Connect Gmail first.' }, { status: 400 });
  if (!hasScope(account, PHOTOS_OAUTH_SCOPE)) return NextResponse.json({ error: 'Turn on profile photos first.' }, { status: 400 });
  const result = await syncProfilePhotos(account);
  if (result.error) return NextResponse.json({ error: result.error, ...result }, { status: 502 });
  return NextResponse.json(result);
});
