import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId, requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { extractVariables, htmlToPlainText } from '@/lib/templates/variables';

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const includeArchived = url.searchParams.get('includeArchived') === 'true';

  const templates = await prisma.template.findMany({
    where: { workspaceId, ...(includeArchived ? {} : { archived: false }) },
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { versions: true } },
      versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, subject: true, createdAt: true } },
    },
  });

  return NextResponse.json({ templates });
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  subject: z.string().max(500).default(''),
  html: z.string().default(''),
  css: z.string().optional(),
  plainText: z.string().optional(),
  workspaceId: z.string().optional(),
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  const body = createSchema.parse(await req.json());
  const workspaceId = await resolveWorkspaceId(session, body.workspaceId);

  // Same rule as the versions route: resolve plainText once so the stored
  // value and the extracted variable list always agree.
  const effectivePlainText = body.plainText ?? (body.html ? htmlToPlainText(body.html) : null);

  // Creating a template always creates v1 alongside it, so a template can
  // never exist without a version a campaign could reference (§21).
  const template = await prisma.template.create({
    data: {
      organizationId: session.organizationId,
      workspaceId,
      ownerId: session.userId,
      name: body.name,
      description: body.description,
      versions: {
        create: {
          version: 1,
          subject: body.subject,
          html: body.html,
          css: body.css,
          plainText: effectivePlainText,
          variables: extractVariables(body.subject, body.html, effectivePlainText),
          createdById: session.userId,
        },
      },
    },
    include: { versions: true },
  });

  await audit(session, 'TEMPLATE_CREATE', { targetType: 'Template', targetId: template.id });

  return NextResponse.json({ template }, { status: 201 });
});
