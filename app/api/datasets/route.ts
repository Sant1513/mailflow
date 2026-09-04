import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId, requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));

  const datasets = await prisma.dataset.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { records: true, columns: true } } },
  });

  return NextResponse.json({ datasets });
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  workspaceId: z.string().optional(),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const body = createSchema.parse(await req.json());
  const workspaceId = await resolveWorkspaceId(session, body.workspaceId);

  const dataset = await prisma.dataset.create({
    data: {
      organizationId: session.organizationId,
      workspaceId,
      ownerId: session.userId,
      name: body.name,
      description: body.description,
    },
  });

  await audit(session, 'DATASET_CREATE', { targetType: 'Dataset', targetId: dataset.id });

  return NextResponse.json({ dataset }, { status: 201 });
});
