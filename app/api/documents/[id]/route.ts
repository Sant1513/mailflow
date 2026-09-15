import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { canEditIn, documentPayload, loadDocumentTemplateForSession, requireOwnWorkspace } from '@/lib/documents/access';
import { inspectionOf } from '@/lib/documents/campaign';
import { checkDocumentConfig } from '@/lib/documents/checks';
import { deleteFileIfUnused } from '@/lib/documents/storage';
import { documentFieldsSchema, LOCK_MODES, parseFields } from '@/lib/documents/types';
import type { Prisma } from '@prisma/client';

export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const t = await loadDocumentTemplateForSession(session, params.id);
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (t.workspaceId !== session.workspaceId) {
    await audit(session, 'ADMIN_VIEW', { targetType: 'DocumentTemplate', targetId: t.id });
  }

  const inspection = inspectionOf(t.file);
  const usage = await prisma.campaignDocument.findMany({
    where: { documentTemplateId: t.id },
    orderBy: { createdAt: 'desc' },
    select: { snapshotAt: true, campaign: { select: { id: true, name: true, status: true } } },
  });

  return NextResponse.json({
    document: documentPayload(t),
    inspection,
    issues: checkDocumentConfig({ fields: parseFields(t.fields), fileNamePattern: t.fileNamePattern }, inspection),
    campaigns: usage.map((u) => ({ ...u.campaign, snapshotAt: u.snapshotAt })),
    canEdit: canEditIn(session, t.workspaceId),
  });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  fields: documentFieldsSchema.optional(),
  fileNamePattern: z.string().trim().min(1, 'A file name is required').max(200).optional(),
  lockMode: z.enum(LOCK_MODES).optional(),
  stampReference: z.boolean().optional(),
  archived: z.boolean().optional(),
});

/**
 * Saves the field map and options. Configuration problems are returned as
 * issues rather than rejected, so a half-finished document can be saved;
 * a campaign cannot SEND while any issue is an error.
 */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const t = await loadDocumentTemplateForSession(session, params.id);
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  requireOwnWorkspace(session, t.workspaceId);

  const body = patchSchema.parse(await req.json());
  if (body.fields) {
    const ids = body.fields.map((f) => f.id);
    if (new Set(ids).size !== ids.length) {
      return NextResponse.json({ error: 'Two fields share an id; reload the editor and try again.' }, { status: 400 });
    }
  }

  await prisma.documentTemplate.update({
    where: { id: t.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.fields !== undefined ? { fields: body.fields as unknown as Prisma.InputJsonValue } : {}),
      ...(body.fileNamePattern !== undefined ? { fileNamePattern: body.fileNamePattern } : {}),
      ...(body.lockMode !== undefined ? { lockMode: body.lockMode } : {}),
      ...(body.stampReference !== undefined ? { stampReference: body.stampReference } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
    },
  });

  const updated = (await loadDocumentTemplateForSession(session, t.id))!;
  const inspection = inspectionOf(updated.file);
  const issues = checkDocumentConfig({ fields: parseFields(updated.fields), fileNamePattern: updated.fileNamePattern }, inspection);

  await audit(session, 'DOCUMENT_TEMPLATE_UPDATE', {
    targetType: 'DocumentTemplate',
    targetId: t.id,
    metadata: { changed: Object.keys(body), fieldCount: parseFields(updated.fields).length, errors: issues.filter((i) => i.level === 'error').length },
  });

  return NextResponse.json({ document: documentPayload(updated), inspection, issues });
});

/** Deletes an unused document; a document a campaign has used is archived instead so its history stays intact. */
export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const t = await loadDocumentTemplateForSession(session, params.id);
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  requireOwnWorkspace(session, t.workspaceId);

  const used = await prisma.campaignDocument.count({ where: { documentTemplateId: t.id } });
  if (used > 0) {
    await prisma.documentTemplate.update({ where: { id: t.id }, data: { archived: true } });
    await audit(session, 'DOCUMENT_TEMPLATE_ARCHIVE', { targetType: 'DocumentTemplate', targetId: t.id, metadata: { reason: 'delete requested but campaigns use it', campaigns: used } });
    return NextResponse.json({
      archivedInsteadOfDeleted: true,
      message: `Archived instead of deleted: ${used} campaign(s) use this document and their history is kept.`,
    });
  }

  await prisma.documentTemplate.delete({ where: { id: t.id } });
  await deleteFileIfUnused(t.fileId);
  await audit(session, 'DOCUMENT_TEMPLATE_DELETE', { targetType: 'DocumentTemplate', targetId: t.id, metadata: { name: t.name } });
  return NextResponse.json({ ok: true });
});
