import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { resolveWorkspaceId, requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { inspectPdf, DocumentFileError } from '@/lib/documents/inspect';
import { readUploadedPdf, storeDocumentFile } from '@/lib/documents/storage';
import { sanitizeFileName } from '@/lib/documents/values';
import { parseFields } from '@/lib/documents/types';

export const maxDuration = 30;

/** Personalised document library for the workspace (PDF agreements, forms, letters). */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session, url.searchParams.get('workspaceId'));
  const includeArchived = url.searchParams.get('includeArchived') === 'true';

  const rows = await prisma.documentTemplate.findMany({
    where: { workspaceId, ...(includeArchived ? {} : { archived: false }) },
    orderBy: { updatedAt: 'desc' },
    include: {
      file: { select: { fileName: true, size: true, pageCount: true, formFields: true } },
      owner: { select: { name: true } },
      _count: { select: { campaignDocuments: true } },
    },
  });

  return NextResponse.json({
    documents: rows.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      archived: d.archived,
      updatedAt: d.updatedAt,
      owner: d.owner.name,
      fileName: d.file.fileName,
      size: d.file.size,
      pageCount: d.file.pageCount,
      formFieldCount: Array.isArray(d.file.formFields) ? d.file.formFields.length : 0,
      fieldCount: parseFields(d.fields).length,
      lockMode: d.lockMode,
      campaignCount: d._count.campaignDocuments,
    })),
  });
});

/** Upload a PDF (multipart: file, optional name). Creates a document with no fields yet. */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);

  const upload = await readUploadedPdf(req);
  if ('error' in upload) return NextResponse.json({ error: upload.error }, { status: upload.status });
  const workspaceId = await resolveWorkspaceId(session, (upload.form.get('workspaceId') as string | null) || null);

  let inspection;
  try {
    inspection = await inspectPdf(upload.bytes);
  } catch (err) {
    if (err instanceof DocumentFileError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  const stored = await storeDocumentFile(session, upload.file.name || 'document.pdf', upload.bytes, inspection);
  const requested = String(upload.form.get('name') ?? '').trim();
  const name = (requested || upload.file.name.replace(/\.pdf$/i, '') || 'Untitled document').slice(0, 200);

  const document = await prisma.documentTemplate.create({
    data: {
      organizationId: session.organizationId,
      workspaceId,
      ownerId: session.userId,
      name,
      fileId: stored.id,
      fields: [],
      // Static until the owner adds {{Variables}} in the editor — a default
      // like "{{Name}}" would block campaigns whose dataset has no Name column.
      fileNamePattern: sanitizeFileName(name),
    },
    select: { id: true, name: true },
  });

  await audit(session, 'DOCUMENT_TEMPLATE_CREATE', {
    targetType: 'DocumentTemplate',
    targetId: document.id,
    metadata: { fileName: upload.file.name, size: upload.bytes.length, pages: inspection.pageCount, formFields: inspection.formFields.length },
  });

  return NextResponse.json({ document, inspection }, { status: 201 });
});
