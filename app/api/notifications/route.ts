import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

/** §87 notification centre: the caller's own notifications, newest first. */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? '20')));
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: session.userId }, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.notification.count({ where: { userId: session.userId, read: false } }),
  ]);
  return NextResponse.json({ notifications: items, unread });
});

const markSchema = z.object({
  ids: z.array(z.string().min(1)).max(200).optional(),
  all: z.boolean().optional(),
});

/** Mark notifications read — only the caller's own rows can ever be touched. */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  const body = markSchema.parse(await req.json());
  const result = await prisma.notification.updateMany({
    where: { userId: session.userId, read: false, ...(body.all ? {} : { id: { in: body.ids ?? [] } }) },
    data: { read: true },
  });
  const unread = await prisma.notification.count({ where: { userId: session.userId, read: false } });
  return NextResponse.json({ marked: result.count, unread });
});
