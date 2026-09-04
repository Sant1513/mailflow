import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { Role } from '@prisma/client';

export async function loadAutomationForSession(
  session: Awaited<ReturnType<typeof requireSession>>,
  automationId: string
) {
  const automation = await prisma.automation.findUnique({
    where: { id: automationId },
    include: {
      versions: { orderBy: { version: 'desc' } },
      runs: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  });
  if (!automation) return null;
  if (automation.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenError('Not your workspace');
  }
  return automation;
}

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const automation = await loadAutomationForSession(session, params.id);
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ automation });
});

const patchSchema = z.object({ name: z.string().min(1).max(200).optional() });

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const automation = await loadAutomationForSession(session, params.id);
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = patchSchema.parse(await req.json());
  const updated = await prisma.automation.update({ where: { id: automation.id }, data: body });
  await audit(session, 'AUTOMATION_UPDATE', { targetType: 'Automation', targetId: automation.id, metadata: body });
  return NextResponse.json({ automation: updated });
});

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session.role);
  const automation = await loadAutomationForSession(session, params.id);
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (automation.enabled) {
    return NextResponse.json(
      { error: 'Disable the automation before deleting it.' },
      { status: 409 }
    );
  }

  // Run history is the audit trail for emails that were actually sent, so
  // it is preserved by detaching rather than cascading a delete (§72/§130).
  const runCount = await prisma.automationRun.count({ where: { automationId: automation.id } });
  if (runCount > 0) {
    return NextResponse.json(
      {
        error: `This automation has ${runCount} run(s) in its history, which must be preserved. Disable it instead of deleting.`,
      },
      { status: 409 }
    );
  }

  await prisma.automationVersion.deleteMany({ where: { automationId: automation.id } });
  await prisma.automation.delete({ where: { id: automation.id } });
  await audit(session, 'AUTOMATION_DELETE', { targetType: 'Automation', targetId: automation.id });
  return NextResponse.json({ ok: true });
});
