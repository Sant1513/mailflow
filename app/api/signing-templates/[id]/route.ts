import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { mergeSigningFieldDefs } from '@/lib/signing/fields';
import { signaturePlacementsSchema } from '@/lib/signing/placements';
import type { Prisma } from '@prisma/client';

/** GET /api/signing-templates/[id] — fetch one template for the current workspace. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const template = await prisma.signingTemplate.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
    include: { createdBy: { select: { name: true, email: true } } },
  });

  if (!template) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  return NextResponse.json({ template });
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

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  content: z.string().min(1).optional(),
  fieldDefs: z.array(fieldDefSchema).optional(),
  signerPresets: z.array(signerPresetSchema).max(3).optional(),
  signaturePlacements: signaturePlacementsSchema.optional(),
  archived: z.boolean().optional(),
});

/** PATCH /api/signing-templates/[id] — update fields or toggle archived. */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const existing = await prisma.signingTemplate.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
  });
  if (!existing) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const body = patchSchema.parse(await req.json());
  const nextContent = body.content ?? existing.content;
  const nextFieldDefs = body.fieldDefs !== undefined
    ? mergeSigningFieldDefs(nextContent, body.fieldDefs)
    : body.content !== undefined
      ? mergeSigningFieldDefs(nextContent, Array.isArray(existing.fieldDefs) ? existing.fieldDefs as any[] : [])
      : undefined;

  const template = await prisma.signingTemplate.update({
    where: { id: existing.id },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.content !== undefined && { content: body.content }),
      ...(nextFieldDefs !== undefined && { fieldDefs: nextFieldDefs as unknown as Prisma.InputJsonValue }),
      ...(body.signerPresets !== undefined && { signerPresets: body.signerPresets as unknown as Prisma.InputJsonValue }),
      ...(body.signaturePlacements !== undefined && {
        signaturePlacements: body.signaturePlacements as unknown as Prisma.InputJsonValue,
      }),
      ...(body.archived !== undefined && { archived: body.archived }),
    },
  });

  await audit(session, 'SIGNING_TEMPLATE_UPDATE', {
    targetType: 'SigningTemplate',
    targetId: template.id,
  });

  return NextResponse.json({ template });
});

/** DELETE /api/signing-templates/[id] — soft-delete (archive) a template. */
export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const existing = await prisma.signingTemplate.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
  });
  if (!existing) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const template = await prisma.signingTemplate.update({
    where: { id: existing.id },
    data: { archived: true },
  });

  await audit(session, 'SIGNING_TEMPLATE_DELETE', {
    targetType: 'SigningTemplate',
    targetId: template.id,
  });

  return NextResponse.json({ template });
});
