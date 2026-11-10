import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { z } from 'zod';
import { buildContactWhere, segmentFiltersSchema } from '../_filterContacts';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const segment = await prisma.contactSegment.findUnique({ where: { id: params.id } });
  if (!segment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (segment.workspaceId !== session.workspaceId) throw new ForbiddenError();

  const filters = segment.filters as Record<string, unknown>;
  const count = await prisma.contact.count({
    where: { workspaceId: segment.workspaceId, ...buildContactWhere(filters) },
  });

  return NextResponse.json({ segment, contactCount: count });
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);

  const segment = await prisma.contactSegment.findUnique({ where: { id: params.id } });
  if (!segment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (segment.workspaceId !== session.workspaceId) throw new ForbiddenError();

  const { name, description, filters } = z
    .object({ name: z.string().max(200).optional(), description: z.string().max(1000).nullish(), filters: segmentFiltersSchema.optional() })
    .parse(await req.json());

  if (name !== undefined && !name.trim()) {
    return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
  }

  const updated = await prisma.contactSegment.update({
    where: { id: params.id },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(description !== undefined ? { description: description?.trim() || null } : {}),
      ...(filters !== undefined ? { filters: filters as Prisma.InputJsonValue } : {}),
    },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ segment: updated });
});

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);

  const segment = await prisma.contactSegment.findUnique({ where: { id: params.id } });
  if (!segment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (segment.workspaceId !== session.workspaceId) throw new ForbiddenError();

  await prisma.contactSegment.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
});
