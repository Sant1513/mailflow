import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId } from '@/lib/permissions/workspace';

const PAGE_SIZE = 50;

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const q = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));

  const where = {
    workspaceId,
    ...(q ? { email: { contains: q, mode: 'insensitive' as const } } : {}),
  };

  const [suppressions, total] = await Promise.all([
    prisma.emailSuppression.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        email: true,
        reason: true,
        source: true,
        detail: true,
        createdAt: true,
        addedBy: { select: { name: true, email: true } },
        campaign: { select: { id: true, name: true } },
      },
    }),
    prisma.emailSuppression.count({ where }),
  ]);

  return NextResponse.json({ suppressions, total, page, pageCount: Math.ceil(total / PAGE_SIZE) });
});

const PostSchema = z.object({
  email: z.string().email(),
  reason: z.enum(['UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT']).default('UNSUBSCRIBED'),
  detail: z.string().optional(),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const body = PostSchema.parse(await req.json());

  const suppression = await prisma.emailSuppression.upsert({
    where: { workspaceId_email: { workspaceId, email: body.email.toLowerCase() } },
    create: {
      workspaceId,
      email: body.email.toLowerCase(),
      reason: body.reason,
      source: 'MANUAL',
      addedByUserId: session.userId,
      detail: body.detail ?? null,
    },
    update: {
      reason: body.reason,
      source: 'MANUAL',
      addedByUserId: session.userId,
      detail: body.detail ?? null,
    },
    select: { id: true, email: true, reason: true, source: true, detail: true, createdAt: true },
  });

  return NextResponse.json(suppression, { status: 201 });
});

export const DELETE = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  await prisma.emailSuppression.deleteMany({
    where: { id, workspaceId },
  });

  return NextResponse.json({ ok: true });
});
