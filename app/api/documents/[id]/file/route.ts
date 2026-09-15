import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { documentPayload, loadDocumentTemplateForSession, requireOwnWorkspace } from '@/lib/documents/access';
import { checkDocumentConfig } from '@/lib/documents/checks';
import { contentDisposition } from '@/lib/documents/http';
import { DocumentFileError, inspectPdf } from '@/lib/documents/inspect';
import { deleteFileIfUnused, readUploadedPdf, storeDocumentFile } from '@/lib/documents/storage';
import { parseFields } from '@/lib/documents/types';

export const maxDuration = 30;

/** The document's current PDF, shown page by page in the editor. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const t = await loadDocumentTemplateForSession(session, params.id);
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const row = await prisma.documentFile.findUnique({ where: { id: t.fileId }, select: { data: true, fileName: true } });
  if (!row) return NextResponse.json({ error: 'The PDF for this document is missing.' }, { status: 404 });

  return new NextResponse(new Uint8Array(row.data), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition('inline', row.fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

/**
 * Replaces the PDF and keeps the field map. Fields that no longer match the
 * new file (a renamed form field, a page that is gone) come back as issues.
 * Campaigns that already attached the old version keep their snapshot.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const t = await loadDocumentTemplateForSession(session, params.id);
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  requireOwnWorkspace(session, t.workspaceId);

  const upload = await readUploadedPdf(req);
  if ('error' in upload) return NextResponse.json({ error: upload.error }, { status: upload.status });

  let inspection;
  try {
    inspection = await inspectPdf(upload.bytes);
  } catch (err) {
    if (err instanceof DocumentFileError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  const stored = await storeDocumentFile(session, upload.file.name || t.file.fileName, upload.bytes, inspection);
  const previousFileId = t.fileId;
  await prisma.documentTemplate.update({ where: { id: t.id }, data: { fileId: stored.id } });
  if (previousFileId !== stored.id) await deleteFileIfUnused(previousFileId);

  const updated = (await loadDocumentTemplateForSession(session, t.id))!;
  const issues = checkDocumentConfig({ fields: parseFields(updated.fields), fileNamePattern: updated.fileNamePattern }, inspection);

  await audit(session, 'DOCUMENT_TEMPLATE_REPLACE_FILE', {
    targetType: 'DocumentTemplate',
    targetId: t.id,
    metadata: { fileName: upload.file.name, size: upload.bytes.length, pages: inspection.pageCount, errors: issues.filter((i) => i.level === 'error').length },
  });

  return NextResponse.json({ document: documentPayload(updated), inspection, issues });
});
