import { NextResponse } from 'next/server';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { cleanImportedPlaceholders, googleDocId } from '@/lib/signing/docImport';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 4 * 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** What a signing document may contain: text formatting, tables, lists and inline images. */
function sanitizeDocument(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'blockquote', 'hr', 'span', 'div'],
    allowedAttributes: { a: ['href'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data', 'https'] },
    allowProtocolRelative: false,
  });
}

async function fetchGoogleDoc(url: string): Promise<{ buffer: Buffer; name: string } | { error: string }> {
  const id = googleDocId(url);
  if (!id) return { error: 'Paste a Google Docs link (docs.google.com/document/d/…).' };
  // Only this host and path are ever fetched: the id is validated above.
  const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=docx`, { redirect: 'follow' });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.includes('officedocument')) {
    return { error: 'Could not open that Google Doc. Share it as "Anyone with the link can view", or download it as .docx and upload the file.' };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) return { error: 'That document is over 4 MB. Remove large images and try again.' };
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'Google Doc';
  return { buffer, name: decodeURIComponent(name).replace(/\.docx$/i, '') };
}

/**
 * POST /api/signing-templates/import: a .docx upload (multipart "file") or
 * a Google Doc link (JSON { url }) becomes template HTML, with {{fields}}
 * detected. Nothing is saved: the editor fills in and the user reviews.
 */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);

  let buffer: Buffer;
  let name: string;
  let source: 'docx' | 'google_doc';
  const type = req.headers.get('content-type') ?? '';

  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a .docx file.' }, { status: 400 });
    if (!/\.docx$/i.test(file.name) && file.type !== DOCX_MIME) {
      return NextResponse.json({ error: 'Only Word .docx files can be imported. Save .doc files as .docx first.' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'That file is over 4 MB. Remove large images and try again.' }, { status: 400 });
    buffer = Buffer.from(await file.arrayBuffer());
    name = file.name.replace(/\.docx$/i, '');
    source = 'docx';
  } else {
    const body = (await req.json().catch(() => ({}))) as { url?: string };
    const doc = await fetchGoogleDoc(body.url ?? '');
    if ('error' in doc) return NextResponse.json({ error: doc.error }, { status: 400 });
    buffer = doc.buffer;
    name = doc.name;
    source = 'google_doc';
  }

  let converted: { value: string; messages: { type: string; message: string }[] };
  try {
    converted = await mammoth.convertToHtml({ buffer });
  } catch {
    return NextResponse.json({ error: 'That file could not be read as a Word document.' }, { status: 400 });
  }

  const { html, fields } = cleanImportedPlaceholders(sanitizeDocument(converted.value));
  if (!html.replace(/<[^>]+>/g, '').trim()) return NextResponse.json({ error: 'The document looks empty.' }, { status: 400 });

  await audit(session, 'SIGNING_TEMPLATE_IMPORTED', { metadata: { source, name: name.slice(0, 120), fields: fields.length } });

  const warnings = converted.messages.filter((m) => m.type === 'warning').length;
  return NextResponse.json({ title: name.slice(0, 200), content: html, fields, warnings });
});
