import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadTemplateForSession } from '@/lib/templates/access';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (template.workspaceId !== session.workspaceId) {
    await audit(session, 'ADMIN_VIEW', { targetType: 'Template', targetId: template.id });
  }

  return NextResponse.json({ template });
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  archived: z.boolean().optional(),
});

export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = patchSchema.parse(await req.json());
  const updated = await prisma.template.update({ where: { id: template.id }, data: body });

  await audit(session, body.archived === true ? 'TEMPLATE_ARCHIVE' : 'TEMPLATE_EDIT', {
    targetType: 'Template',
    targetId: template.id,
    metadata: body,
  });

  return NextResponse.json({ template: updated });
});

/**
 * Templates are archived, not deleted, when any campaign references them —
 * deleting would break the historical record a past campaign points at
 * (§21/§126 historical integrity).
 */
export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const campaignCount = await prisma.campaign.count({ where: { templateId: template.id } });
  if (campaignCount > 0) {
    const archived = await prisma.template.update({
      where: { id: template.id },
      data: { archived: true },
    });
    await audit(session, 'TEMPLATE_ARCHIVE', {
      targetType: 'Template',
      targetId: template.id,
      metadata: { reason: 'delete requested but campaigns reference it', campaignCount },
    });
    return NextResponse.json({
      template: archived,
      archivedInsteadOfDeleted: true,
      message: `Archived instead of deleted — ${campaignCount} campaign(s) reference this template's history.`,
    });
  }

  await prisma.template.delete({ where: { id: template.id } });
  await audit(session, 'TEMPLATE_DELETE', { targetType: 'Template', targetId: template.id });

  return NextResponse.json({ ok: true });
});
