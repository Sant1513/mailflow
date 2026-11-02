import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { putFile, storageEnabled } from '@/lib/storage/files';

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB per file
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);

/**
 * POST /api/e-sign/attachments — upload one file (multipart field "file") for a signing
 * request. Stored privately in Supabase Storage (lib/storage/files.ts); once the request is
 * final, the laptop server archives it and frees the cloud space. Returns
 * { url, name, contentType, size } where url is the storage reference.
 */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();

  const formData = await req.formData();
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: 'Unsupported file type. Allowed: PDF, Word, JPEG, PNG.' }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large. Maximum 10 MB.' }, { status: 400 });
  }

  const safeName = file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const path = `signing-attachments/${session.workspaceId ?? 'shared'}/${Date.now()}-${safeName}`;

  if (storageEnabled()) {
    const ref = await putFile(path, Buffer.from(await file.arrayBuffer()), file.type);
    return NextResponse.json({ url: ref, name: file.name, contentType: file.type, size: file.size });
  }
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(path, file, { access: 'public', contentType: file.type });
    return NextResponse.json({ url: blob.url, name: file.name, contentType: file.type, size: file.size });
  }
  return NextResponse.json(
    { error: 'File storage is not set up yet, so attachments can\'t be uploaded. An admin needs to add SUPABASE_URL and SUPABASE_SERVICE_KEY.' },
    { status: 503 },
  );
});
