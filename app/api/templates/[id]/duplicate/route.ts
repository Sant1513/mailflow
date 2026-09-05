import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadTemplateForSession, latestVersionOf } from '@/lib/templates/access';

/**
 * §20 Duplicate. The copy starts at v1 with the source's latest content —
 * it deliberately does NOT inherit the original's version history, which
 * belongs to the original's campaigns.
 */
export const POST = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const latest = latestVersionOf(template.versions);
  if (!latest) return NextResponse.json({ error: 'Template has no content to duplicate' }, { status: 400 });

  const copy = await prisma.template.create({
    data: {
      organizationId: session.organizationId,
      workspaceId: session.workspaceId!,
      ownerId: session.userId,
      name: `${template.name} (copy)`,
      description: template.description,
      versions: {
        create: {
          version: 1,
          subject: latest.subject,
          html: latest.html,
          css: latest.css,
          plainText: latest.plainText,
          variables: latest.variables as string[],
          createdById: session.userId,
        },
      },
    },
    include: { versions: true },
  });

  await audit(session, 'TEMPLATE_DUPLICATE', {
    targetType: 'Template',
    targetId: copy.id,
    metadata: { sourceTemplateId: template.id },
  });

  return NextResponse.json({ template: copy }, { status: 201 });
});
