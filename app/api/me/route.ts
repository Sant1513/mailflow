import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';

/** The caller's own profile — the only things a person edits about themselves. */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, name: true, email: true, role: true, slackUserId: true } });
  return NextResponse.json({ me });
});

const patchSchema = z.object({
  slackUserId: z.string().trim().max(40).regex(/^(U|W)[A-Z0-9]{6,}$|^$/, 'Slack member ids look like U04ABCDEF').optional(),
});

export const PATCH = withErrorHandling(async (req) => {
  const session = await requireSession();
  if (session.viewingAs) return NextResponse.json({ error: 'Read-only while viewing another workspace' }, { status: 403 });
  const body = patchSchema.parse(await req.json());
  const me = await prisma.user.update({
    where: { id: session.userId },
    data: { ...(body.slackUserId !== undefined ? { slackUserId: body.slackUserId || null } : {}) },
    select: { id: true, name: true, email: true, role: true, slackUserId: true },
  });
  await audit(session, 'PROFILE_UPDATE', { targetType: 'User', targetId: session.userId, metadata: { fields: Object.keys(body) } });
  return NextResponse.json({ me });
});
