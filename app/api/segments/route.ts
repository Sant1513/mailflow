import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const segments = await prisma.contactSegment.findMany({
    where: { workspaceId: session.workspaceId! },
    orderBy: { createdAt: 'desc' },
    include: { createdBy: { select: { id: true, name: true } } },
  });
  return NextResponse.json({ segments });
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);

  const body = await req.json();
  const { name, description, filters } = body as {
    name?: string;
    description?: string;
    filters?: Record<string, unknown>;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const segment = await prisma.contactSegment.create({
    data: {
      workspaceId: session.workspaceId!,
      createdById: session.userId,
      name: name.trim(),
      description: description?.trim() || null,
      filters: (filters ?? {}) as Prisma.InputJsonValue,
    },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ segment }, { status: 201 });
});
