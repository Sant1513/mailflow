import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

const patchSchema = z.object({
  emailSignature: z.string().max(10_000).nullable().optional(),
});

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.userId },
    select: { id: true, name: true, email: true, emailSignature: true },
  });
  return NextResponse.json({ user });
});

export const PATCH = withErrorHandling(async (req) => {
  const session = await requireSession();
  const body = patchSchema.parse(await req.json());
  const user = await prisma.user.update({
    where: { id: session.userId },
    data: {
      ...(body.emailSignature !== undefined ? { emailSignature: body.emailSignature } : {}),
    },
    select: { id: true, name: true, email: true, emailSignature: true },
  });
  return NextResponse.json({ user });
});
