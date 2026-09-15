import { prisma } from '@/lib/db/client';
import { CampaignStatus, type DocumentLockMode, type Prisma } from '@prisma/client';
import { checkDocumentConfig } from './checks';
import { DocumentFileError } from './inspect';
import { DocumentRenderError, renderDocument, type RenderDocumentOutput } from './render';
import { documentReference, PREVIEW_REFERENCE } from './reference';
import {
  formatDate,
  isoDateInZone,
  parseDateValue,
  resolveField,
  resolveFileName,
  type ResolvedField,
  type SystemValues,
} from './values';
import {
  MAX_ATTACHMENT_BYTES_PER_EMAIL,
  parseFields,
  parseSnapshot,
  type DetectedFormField,
  type DocumentInspection,
  type DocumentIssue,
  type DocumentSnapshot,
  type PageInfo,
} from './types';

/**
 * Server-side glue between personalised documents and campaigns: snapshots,
 * dry-run requirements, validation, per-job value freezing, and generation.
 */

/** Documents may be attached / changed only before review, so approval always covers what is sent. */
export const DOCUMENT_EDITABLE_STATUSES: CampaignStatus[] = [CampaignStatus.DRAFT, CampaignStatus.REJECTED, CampaignStatus.SCHEDULED];

export function documentsLockedMessage(status: string): string {
  return `Documents can only be changed while the campaign is a draft or rejected (it is ${status.replace(/_/g, ' ').toLowerCase()}). An approval covers the exact documents that go out, so a reviewer must request changes first.`;
}

export const FILE_META_SELECT = {
  id: true,
  sha256: true,
  fileName: true,
  size: true,
  pageCount: true,
  pages: true,
  formFields: true,
  hasXfa: true,
  createdAt: true,
} as const;

export interface FileMeta {
  pageCount: number;
  pages: unknown;
  formFields: unknown;
  hasXfa: boolean;
}

export function inspectionOf(file: FileMeta): DocumentInspection {
  return {
    pageCount: file.pageCount,
    pages: (Array.isArray(file.pages) ? file.pages : []) as PageInfo[],
    formFields: (Array.isArray(file.formFields) ? file.formFields : []) as DetectedFormField[],
    hasXfa: file.hasXfa,
  };
}

/** The parts of a library document (or a campaign snapshot of one) that generation reads. */
export interface DocumentSource {
  name: string;
  fileId: string;
  fields: unknown;
  fileNamePattern: string;
  lockMode: DocumentLockMode;
  stampReference: boolean;
}

export async function loadCampaignDocuments(campaignId: string) {
  return prisma.campaignDocument.findMany({
    where: { campaignId },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: { file: { select: FILE_META_SELECT } },
  });
}

export type LoadedCampaignDocument = Awaited<ReturnType<typeof loadCampaignDocuments>>[number];

export function snapshotFromTemplate(t: DocumentSource) {
  return {
    name: t.name,
    fileId: t.fileId,
    fields: (t.fields ?? []) as Prisma.InputJsonValue,
    fileNamePattern: t.fileNamePattern,
    lockMode: t.lockMode,
    stampReference: t.stampReference,
    snapshotAt: new Date(),
  };
}

/** What changed in the library since the campaign took its snapshot (empty = up to date). */
export function snapshotDrift(snapshot: DocumentSource, library: DocumentSource): string[] {
  const changes: string[] = [];
  if (snapshot.fileId !== library.fileId) changes.push('PDF replaced');
  if (JSON.stringify(snapshot.fields) !== JSON.stringify(library.fields)) changes.push('fields changed');
  if (snapshot.fileNamePattern !== library.fileNamePattern) changes.push('file name changed');
  if (snapshot.lockMode !== library.lockMode) changes.push('lock mode changed');
  if (snapshot.stampReference !== library.stampReference) changes.push('reference line changed');
  if (snapshot.name !== library.name) changes.push('renamed');
  return changes;
}

export interface SystemContext {
  campaignName: string;
  timezone: string;
  senderName: string;
  senderEmail: string;
  now: Date;
}

export function systemValuesFor(ctx: SystemContext, recipientEmail: string | null, reference: string): SystemValues {
  return {
    Today: isoDateInZone(ctx.now, ctx.timezone),
    SenderName: ctx.senderName,
    SenderEmail: ctx.senderEmail,
    CampaignName: ctx.campaignName,
    RecipientEmail: recipientEmail ?? '',
    DocumentId: reference,
  };
}

export interface ResolvedDocument {
  fileName: string;
  fields: ResolvedField[];
  values: Record<string, string>;
  blocking: ResolvedField[];
  warnings: string[];
}

export function resolveDocument(doc: Pick<DocumentSource, 'name' | 'fields' | 'fileNamePattern'>, data: Record<string, unknown>, system: SystemValues): ResolvedDocument {
  const resolved = parseFields(doc.fields).map((f) => resolveField(f, data, system));
  return {
    fileName: resolveFileName(doc.fileNamePattern, data, system, doc.name),
    fields: resolved,
    values: Object.fromEntries(resolved.map((r) => [r.id, r.value])),
    blocking: resolved.filter((r) => r.blocking),
    warnings: resolved.flatMap((r) => r.warnings.map((w) => `${r.label}: ${w}`)),
  };
}

/**
 * Editor preview without a recipient: text fields show their value template
 * ("{{Name}}") so placement can be checked; choice fields stay empty, since a
 * literal "{{Batch}}" is not a valid dropdown option.
 */
export function placeholderDocument(doc: Pick<DocumentSource, 'name' | 'fields' | 'fileNamePattern'>, inspection: DocumentInspection): ResolvedDocument {
  const types = new Map(inspection.formFields.map((f) => [f.name, f.type]));
  const fields: ResolvedField[] = parseFields(doc.fields).map((f) => {
    const choice = f.target.kind === 'form' && types.get(f.target.fieldName) !== 'text';
    return {
      id: f.id,
      label: f.label,
      value: choice ? '' : f.value || `[${f.label}]`,
      missing: [],
      required: f.required,
      usedFallback: false,
      blocking: false,
      warnings: [],
    };
  });
  return {
    fileName: resolveFileName(doc.fileNamePattern.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, '$1'), {}, {}, doc.name),
    fields,
    values: Object.fromEntries(fields.map((f) => [f.id, f.value])),
    blocking: [],
    warnings: [],
  };
}

export function buildSnapshot(doc: Pick<DocumentSource, 'name'>, resolved: ResolvedDocument, system: SystemValues, now: Date, timezone: string): DocumentSnapshot {
  const iso = isoDateInZone(now, timezone);
  const parts = parseDateValue(iso);
  return {
    v: 1,
    values: resolved.values,
    reference: system.DocumentId || PREVIEW_REFERENCE,
    recipient: system.RecipientEmail || null,
    issuedAt: now.toISOString(),
    issuedLabel: parts ? formatDate(parts, 'D MMM YYYY') : iso,
    title: resolved.fileName.replace(/\.pdf$/i, ''),
    subject: doc.name,
  };
}

/** Input for the pure dry run in lib/campaigns/evaluate.ts. */
export function documentRequirements(docs: Pick<DocumentSource, 'name' | 'fields'>[]) {
  return docs.map((d) => ({
    name: d.name,
    fields: parseFields(d.fields).map((f) => ({ label: f.label, value: f.value, required: f.required })),
  }));
}

/** Campaign-level problems with the attached documents, each prefixed with the document's name. */
export function documentValidationIssues(docs: LoadedCampaignDocument[], columnKeys: string[]): DocumentIssue[] {
  return docs.flatMap((d) =>
    checkDocumentConfig({ fields: parseFields(d.fields), fileNamePattern: d.fileNamePattern }, inspectionOf(d.file), columnKeys).map((issue) => ({
      ...issue,
      message: `${d.name}: ${issue.message}`,
    }))
  );
}

// ── PDF bytes: immutable rows, so cached per process ─────────────────────

const fileCache = new Map<string, Uint8Array>();
let cachedBytes = 0;
const CACHE_LIMIT = 64 * 1024 * 1024;

export async function documentFileBytes(fileId: string): Promise<Uint8Array> {
  const hit = fileCache.get(fileId);
  if (hit) return hit;
  const row = await prisma.documentFile.findUnique({ where: { id: fileId }, select: { data: true } });
  if (!row) throw new DocumentRenderError('The PDF for this document no longer exists.');
  const bytes = new Uint8Array(row.data);
  if (bytes.length < CACHE_LIMIT) {
    while (cachedBytes + bytes.length > CACHE_LIMIT && fileCache.size > 0) {
      const oldest = fileCache.keys().next().value as string | undefined;
      if (!oldest) break;
      cachedBytes -= fileCache.get(oldest)?.length ?? 0;
      fileCache.delete(oldest);
    }
    fileCache.set(fileId, bytes);
    cachedBytes += bytes.length;
  }
  return bytes;
}

/** Generates a copy from a frozen snapshot: the send path and "download sent copy" both use this. */
export async function renderFromSnapshot(doc: Pick<DocumentSource, 'fileId' | 'fields' | 'lockMode' | 'stampReference'>, snapshot: DocumentSnapshot): Promise<RenderDocumentOutput> {
  return renderDocument({
    fileBytes: await documentFileBytes(doc.fileId),
    fields: parseFields(doc.fields),
    values: snapshot.values,
    lockMode: doc.lockMode,
    stamp: doc.stampReference ? { reference: snapshot.reference, recipient: snapshot.recipient, issuedLabel: snapshot.issuedLabel } : null,
    metadata: { title: snapshot.title, subject: snapshot.subject, reference: snapshot.reference, issuedAt: new Date(snapshot.issuedAt) },
  });
}

export interface DocumentPreviewResult {
  ok: boolean;
  error?: string;
  fileName: string;
  fields: ResolvedField[];
  warnings: string[];
  blocking: string[];
  reference: string;
  pdfBase64?: string;
  size?: number;
}

/** Resolves and renders one copy for review. Render problems are reported, not thrown. */
export async function previewDocument(
  doc: DocumentSource,
  options: { data: Record<string, unknown> | null; system: SystemValues; now: Date; timezone: string; inspection: DocumentInspection }
): Promise<DocumentPreviewResult> {
  const resolved = options.data ? resolveDocument(doc, options.data, options.system) : placeholderDocument(doc, options.inspection);
  const snapshot = buildSnapshot(doc, resolved, options.system, options.now, options.timezone);
  const base = {
    fileName: resolved.fileName,
    fields: resolved.fields,
    blocking: resolved.blocking.map((b) => `${b.label} (${b.missing.map((m) => `{{${m}}}`).join(', ')})`),
    reference: snapshot.reference,
  };
  try {
    const out = await renderFromSnapshot(doc, snapshot);
    return { ok: true, ...base, warnings: [...resolved.warnings, ...out.warnings], pdfBase64: Buffer.from(out.bytes).toString('base64'), size: out.bytes.length };
  } catch (err) {
    if (err instanceof DocumentRenderError || err instanceof DocumentFileError) {
      return { ok: false, error: err.message, ...base, warnings: resolved.warnings };
    }
    throw err;
  }
}

/**
 * Freezes, at send time, everything each copy needs: resolved values, file
 * name and a unique reference. Bytes are generated when the email is sent.
 */
export function jobAttachmentRows(args: {
  emailJobId: string;
  docs: (DocumentSource & { id: string })[];
  data: Record<string, unknown>;
  system: SystemContext;
  recipientEmail: string;
}): Prisma.AttachmentCreateManyInput[] {
  return args.docs.map((doc) => {
    const reference = documentReference(`${args.emailJobId}:${doc.id}`);
    const system = systemValuesFor(args.system, args.recipientEmail, reference);
    const resolved = resolveDocument(doc, args.data, system);
    const snapshot = buildSnapshot(doc, resolved, system, args.system.now, args.system.timezone);
    return {
      emailJobId: args.emailJobId,
      filename: resolved.fileName,
      mimeType: 'application/pdf',
      size: 0,
      campaignDocumentId: doc.id,
      documentRef: reference,
      fieldValues: snapshot as unknown as Prisma.InputJsonValue,
    };
  });
}

export interface GeneratedAttachment {
  attachmentId: string;
  filename: string;
  content: Buffer;
  sha256: string;
  size: number;
}

export interface JobDocumentAttachment {
  id: string;
  filename: string;
  fieldValues: unknown;
  campaignDocument: Pick<DocumentSource, 'fileId' | 'fields' | 'lockMode' | 'stampReference'> | null;
}

export async function generateJobDocuments(attachments: JobDocumentAttachment[]): Promise<GeneratedAttachment[]> {
  const out: GeneratedAttachment[] = [];
  for (const a of attachments) {
    if (!a.campaignDocument) throw new DocumentRenderError(`The document behind "${a.filename}" was removed from the campaign.`);
    const snapshot = parseSnapshot(a.fieldValues);
    if (!snapshot) throw new DocumentRenderError(`The saved values for "${a.filename}" could not be read.`);
    const rendered = await renderFromSnapshot(a.campaignDocument, snapshot);
    out.push({ attachmentId: a.id, filename: a.filename, content: Buffer.from(rendered.bytes), sha256: rendered.sha256, size: rendered.bytes.length });
  }
  const total = out.reduce((sum, g) => sum + g.size, 0);
  if (total > MAX_ATTACHMENT_BYTES_PER_EMAIL) {
    throw new DocumentRenderError(`The personalised documents total ${(total / 1048576).toFixed(1)} MB; the limit per email is 18 MB.`);
  }
  return out;
}
