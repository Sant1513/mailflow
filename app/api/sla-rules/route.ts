import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId, requireCanWrite } from '@/lib/permissions/workspace';

/** GET /api/sla-rules — list all SLA rules for the workspace */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));

  const rules = await prisma.slaRule.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    include: { assignee: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ rules });
});

/** POST /api/sla-rules — create a new SLA rule */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));

  const body = await req.json();
  const { name, firstResponseMinutes, resolutionMinutes, appliesTo, tagName, assigneeId, active } = body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!Number.isInteger(firstResponseMinutes) || firstResponseMinutes <= 0) {
    return NextResponse.json({ error: 'firstResponseMinutes must be a positive integer' }, { status: 400 });
  }
  if (!Number.isInteger(resolutionMinutes) || resolutionMinutes <= 0) {
    return NextResponse.json({ error: 'resolutionMinutes must be a positive integer' }, { status: 400 });
  }
  const validAppliesTo = ['ALL', 'TAG', 'ASSIGNEE'];
  const appliesToValue = (appliesTo ?? 'ALL').toUpperCase();
  if (!validAppliesTo.includes(appliesToValue)) {
    return NextResponse.json({ error: 'appliesTo must be ALL, TAG, or ASSIGNEE' }, { status: 400 });
  }
  if (appliesToValue === 'TAG' && (!tagName || typeof tagName !== 'string' || !tagName.trim())) {
    return NextResponse.json({ error: 'tagName is required when appliesTo is TAG' }, { status: 400 });
  }
  if (appliesToValue === 'ASSIGNEE' && (!assigneeId || typeof assigneeId !== 'string')) {
    return NextResponse.json({ error: 'assigneeId is required when appliesTo is ASSIGNEE' }, { status: 400 });
  }

  const rule = await prisma.slaRule.create({
    data: {
      workspaceId,
      name: name.trim(),
      firstResponseMinutes,
      resolutionMinutes,
      appliesTo: appliesToValue,
      tagName: appliesToValue === 'TAG' ? tagName.trim() : null,
      assigneeId: appliesToValue === 'ASSIGNEE' ? assigneeId : null,
      active: active !== false,
    },
    include: { assignee: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ rule }, { status: 201 });
});
