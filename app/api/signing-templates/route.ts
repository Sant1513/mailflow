import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { mergeSigningFieldDefs } from '@/lib/signing/fields';
import type { Prisma } from '@prisma/client';

/** GET /api/signing-templates — list non-archived templates for current workspace. */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const templates = await prisma.signingTemplate.findMany({
    where: { workspaceId: session.workspaceId, archived: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      description: true,
      content: true,
      fieldDefs: true,
      signerPresets: true,
      archived: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { name: true, email: true } },
    },
  });

  return NextResponse.json({ templates });
});

const fieldDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  defaultValue: z.string().optional(),
});

const signerPresetSchema = z.object({
  index: z.number().int().min(1).max(3),
  role: z.string().min(1).max(100),
  nameColumn: z.string().min(1),
  emailColumn: z.string().min(1),
  assignedFields: z.array(z.string()).default([]),
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  content: z.string().min(1),
  fieldDefs: z.array(fieldDefSchema).default([]),
  signerPresets: z.array(signerPresetSchema).max(3).default([]),
});

/** POST /api/signing-templates — create a new template. */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const body = createSchema.parse(await req.json());

  const template = await prisma.signingTemplate.create({
    data: {
      workspaceId: session.workspaceId,
      title: body.title,
      description: body.description,
      content: body.content,
      fieldDefs: mergeSigningFieldDefs(body.content, body.fieldDefs) as unknown as Prisma.InputJsonValue,
      signerPresets: body.signerPresets as unknown as Prisma.InputJsonValue,
      createdById: session.userId,
    },
  });

  await audit(session, 'SIGNING_TEMPLATE_CREATE', {
    targetType: 'SigningTemplate',
    targetId: template.id,
  });

  return NextResponse.json({ template }, { status: 201 });
});
