import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { sha256Hex } from './reference';
import { MAX_UPLOAD_BYTES, type DocumentInspection } from './types';

/**
 * Stores uploaded PDF bytes once per organisation (content-addressed by
 * SHA-256). Rows are never updated, so a campaign snapshot that points at a
 * file keeps generating from exactly those bytes.
 */
export async function storeDocumentFile(
  owner: { organizationId: string; userId: string },
  fileName: string,
  bytes: Uint8Array,
  inspection: DocumentInspection
): Promise<{ id: string }> {
  const sha256 = sha256Hex(bytes);
  const where = { organizationId_sha256: { organizationId: owner.organizationId, sha256 } };
  const existing = await prisma.documentFile.findUnique({ where, select: { id: true } });
  if (existing) return existing;
  try {
    return await prisma.documentFile.create({
      data: {
        organizationId: owner.organizationId,
        sha256,
        fileName: fileName.slice(0, 255),
        size: bytes.length,
        data: Buffer.from(bytes),
        pageCount: inspection.pageCount,
        pages: inspection.pages as unknown as Prisma.InputJsonValue,
        formFields: inspection.formFields as unknown as Prisma.InputJsonValue,
        hasXfa: inspection.hasXfa,
        createdById: owner.userId,
      },
      select: { id: true },
    });
  } catch (err) {
    // Two uploads of the same file at once: the unique constraint wins, reuse the row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const again = await prisma.documentFile.findUnique({ where, select: { id: true } });
      if (again) return again;
    }
    throw err;
  }
}

/** Removes a file no library document and no campaign snapshot references any more. */
export async function deleteFileIfUnused(fileId: string): Promise<boolean> {
  const [templates, snapshots] = await Promise.all([
    prisma.documentTemplate.count({ where: { fileId } }),
    prisma.campaignDocument.count({ where: { fileId } }),
  ]);
  if (templates > 0 || snapshots > 0) return false;
  await prisma.documentFile.delete({ where: { id: fileId } }).catch(() => undefined);
  return true;
}

export type UploadedPdf = { file: File; bytes: Uint8Array; form: FormData } | { error: string; status: number };

/** Reads a multipart upload with a "file" part, enforcing the size limit before buffering. */
export async function readUploadedPdf(req: Request): Promise<UploadedPdf> {
  const form = await req.formData().catch(() => null);
  if (!form) return { error: 'Upload the PDF as multipart form data with a "file" field.', status: 400 };
  const file = form.get('file');
  if (!file || typeof file === 'string') return { error: 'Choose a PDF to upload.', status: 400 };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `The PDF is ${(file.size / 1048576).toFixed(1)} MB; the limit is 4 MB.`, status: 413 };
  }
  return { file, bytes: new Uint8Array(await file.arrayBuffer()), form };
}
