import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { loadDocumentTemplateForSession } from '@/lib/documents/access';
import { inspectionOf, previewDocument, systemValuesFor } from '@/lib/documents/campaign';
import { checkDocumentConfig } from '@/lib/documents/checks';
import { PREVIEW_REFERENCE } from '@/lib/documents/reference';
import { documentFieldsSchema, LOCK_MODES, parseFields } from '@/lib/documents/types';
import { ColumnType, EmailProvider as EmailProviderEnum } from '@prisma/client';

export const maxDuration = 30;

const schema = z.object({
  /** Fill with this dataset row. Omit to preview placement with the value templates themselves. */
  recordId: z.string().optional(),
  /** Unsaved editor state, so the preview matches what is on screen. */
  draft: z
    .object({
      fields: documentFieldsSchema,
      fileNamePattern: z.string().max(200),
      lockMode: z.enum(LOCK_MODES),
      stampReference: z.boolean(),
    })
    .optional(),
});

/** Generates a preview copy. Read-only: nothing is stored and nothing is sent. */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  const t = await loadDocumentTemplateForSession(session, params.id);
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = schema.parse(await req.json().catch(() => ({})));

  const source = {
    name: t.name,
    fileId: t.fileId,
    fields: body.draft?.fields ?? t.fields,
    fileNamePattern: body.draft?.fileNamePattern?.trim() || t.fileNamePattern,
    lockMode: body.draft?.lockMode ?? t.lockMode,
    stampReference: body.draft?.stampReference ?? t.stampReference,
  };

  let data: Record<string, unknown> | null = null;
  let recipientEmail: string | null = null;
  let columnKeys: string[] | null = null;
  if (body.recordId) {
    const record = await prisma.record.findUnique({
      where: { id: body.recordId },
      select: { data: true, dataset: { select: { workspaceId: true, columns: { select: { key: true, type: true } } } } },
    });
    if (!record) return NextResponse.json({ error: 'Record not found' }, { status: 404 });
    if (record.dataset.workspaceId !== t.workspaceId) {
      return NextResponse.json({ error: 'Preview with a record from the same workspace as the document.' }, { status: 400 });
    }
    data = (record.data ?? {}) as Record<string, unknown>;
    columnKeys = record.dataset.columns.map((c) => c.key);
    const emailKey = record.dataset.columns.find((c) => c.type === ColumnType.EMAIL)?.key;
    const raw = emailKey ? data[emailKey] : null;
    recipientEmail = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  const mailbox = await prisma.emailProviderAccount.findUnique({
    where: { workspaceId_userId_provider: { workspaceId: t.workspaceId, userId: session.userId, provider: EmailProviderEnum.GMAIL } },
    select: { emailAddress: true, displayName: true },
  });

  const now = new Date();
  const timezone = 'Asia/Kolkata';
  const system = systemValuesFor(
    { campaignName: 'Preview', timezone, senderName: mailbox?.displayName || session.name, senderEmail: mailbox?.emailAddress || session.email, now },
    recipientEmail,
    PREVIEW_REFERENCE
  );
  const inspection = inspectionOf(t.file);
  const preview = await previewDocument(source, { data, system, now, timezone, inspection });
  const issues = checkDocumentConfig({ fields: parseFields(source.fields), fileNamePattern: source.fileNamePattern }, inspection, columnKeys);

  return NextResponse.json({ preview, issues });
});
