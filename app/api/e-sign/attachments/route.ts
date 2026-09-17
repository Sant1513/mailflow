import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB per file
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);

/**
 * POST /api/e-sign/attachments
 * Upload a file to Vercel Blob. Returns { url, name, contentType, size }.
 * Accepts multipart/form-data with a single field "file".
 */
export const POST = withErrorHandling(async (req) => {
  await requireSession();

  const formData = await req.formData();
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: 'Unsupported file type. Allowed: PDF, Word, JPEG, PNG.' },
      { status: 400 }
    );
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large. Maximum 10 MB.' }, { status: 400 });
  }

  const blob = await put(`signing-attachments/${Date.now()}-${file.name}`, file, {
    access: 'public',
    contentType: file.type,
  });

  return NextResponse.json({
    url: blob.url,
    name: file.name,
    contentType: file.type,
    size: file.size,
  });
});
