import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId, requireCanWrite } from '@/lib/permissions/workspace';

/** PATCH /api/sla-rules/[id] — update an SLA rule */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const workspaceId = await resolveWorkspaceId(session);

  const existing = await prisma.slaRule.findFirst({ where: { id: params.id, workspaceId } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json();
  const { name, firstResponseMinutes, resolutionMinutes, appliesTo, tagName, assigneeId, active } = body;

  const data: Record<string, unknown> = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
    }
    data.name = name.trim();
  }
  if (firstResponseMinutes !== undefined) {
    if (!Number.isInteger(firstResponseMinutes) || firstResponseMinutes <= 0) {
      return NextResponse.json({ error: 'firstResponseMinutes must be a positive integer' }, { status: 400 });
    }
    data.firstResponseMinutes = firstResponseMinutes;
  }
  if (resolutionMinutes !== undefined) {
    if (!Number.isInteger(resolutionMinutes) || resolutionMinutes <= 0) {
      return NextResponse.json({ error: 'resolutionMinutes must be a positive integer' }, { status: 400 });
    }
    data.resolutionMinutes = resolutionMinutes;
  }
  if (appliesTo !== undefined) {
    const validAppliesTo = ['ALL', 'TAG', 'ASSIGNEE'];
    const appliesToValue: string = appliesTo.toUpperCase();
    if (!validAppliesTo.includes(appliesToValue)) {
      return NextResponse.json({ error: 'appliesTo must be ALL, TAG, or ASSIGNEE' }, { status: 400 });
    }
    data.appliesTo = appliesToValue;
    data.tagName = appliesToValue === 'TAG' ? (tagName ?? existing.tagName) : null;
    data.assigneeId = appliesToValue === 'ASSIGNEE' ? (assigneeId ?? existing.assigneeId) : null;
  }
  if (active !== undefined) data.active = Boolean(active);

  const rule = await prisma.slaRule.update({
    where: { id: params.id },
    data,
    include: { assignee: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ rule });
});

/** DELETE /api/sla-rules/[id] — delete an SLA rule */
export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const workspaceId = await resolveWorkspaceId(session);

  const existing = await prisma.slaRule.findFirst({ where: { id: params.id, workspaceId } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.slaRule.delete({ where: { id: params.id } });

  return NextResponse.json({ deleted: true });
});
