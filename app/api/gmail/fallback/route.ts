import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { fallbackOptIns, ownMailbox, setFallbackOptIn } from '@/lib/campaigns/fallback';

/** GET — whether the caller's own Gmail may be used as a backup sender on teammates' campaigns. */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const mailbox = await ownMailbox(session.userId);
  if (!mailbox) return NextResponse.json({ mailbox: null, allowed: false });
  const optIns = await fallbackOptIns(session.organizationId);
  return NextResponse.json({ mailbox: { emailAddress: mailbox.emailAddress, status: mailbox.status }, allowed: optIns.has(mailbox.id) });
});

const bodySchema = z.object({ allow: z.boolean() });

/** POST — only the mailbox owner can allow or withdraw their own mailbox. */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  if (session.viewingAs) return NextResponse.json({ error: 'Read-only while viewing as another user.' }, { status: 403 });
  const { allow } = bodySchema.parse(await req.json());
  const mailbox = await ownMailbox(session.userId);
  if (!mailbox) return NextResponse.json({ error: 'Connect your Gmail first.' }, { status: 400 });
  await setFallbackOptIn(session.organizationId, mailbox.id, allow, session.userId);
  await audit(session, allow ? 'FALLBACK_MAILBOX_ALLOWED' : 'FALLBACK_MAILBOX_WITHDRAWN', {
    targetType: 'EmailProviderAccount',
    targetId: mailbox.id,
    metadata: { emailAddress: mailbox.emailAddress },
  });
  return NextResponse.json({ allowed: allow });
});
