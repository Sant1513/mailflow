import { createHmac } from 'node:crypto';
import { controlDb } from '@/lib/system/serverState';

/**
 * File storage for signing attachments and signed PDFs, kept within Supabase's free plan:
 *
 *   storage:<path>  — in Supabase Storage (private bucket), while the document is in progress.
 *   archive:<path>  — on the laptop server, after the document is final: the laptop downloads
 *                     the file every night, checks it, keeps it under MAILFLOW_DATA\files and
 *                     deletes the cloud copy (laptop-server/start.mjs). Served from there.
 *   https://…       — older attachments (Vercel Blob links).
 *   anything else   — an older signed PDF stored inline as base64.
 *
 * Supabase Storage is used when SUPABASE_URL and SUPABASE_SERVICE_KEY are set; without them
 * signed PDFs stay inline (as before) and new attachments are refused with a clear message.
 */

export const BUCKET = 'mailflow-files';

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}

export function storageEnabled(): boolean {
  return !!config();
}

const headers = (key: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${key}`, apikey: key, ...extra });
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

let bucketReady: Promise<void> | null = null;
function ensureBucket(): Promise<void> {
  const c = config();
  if (!c) return Promise.reject(new Error('File storage is not set up (SUPABASE_URL / SUPABASE_SERVICE_KEY).'));
  bucketReady ??= fetch(`${c.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers(c.key, { 'content-type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  }).then(async (res) => {
    // 400/409 "already exists" is fine.
    if (!res.ok && res.status !== 400 && res.status !== 409) {
      bucketReady = null;
      throw new Error(`Could not prepare file storage (${res.status}).`);
    }
  });
  return bucketReady;
}

/** Uploads and returns the reference to store ("storage:<path>"). */
export async function putFile(path: string, bytes: Buffer | Uint8Array, contentType: string): Promise<string> {
  const c = config();
  if (!c) throw new Error('File storage is not set up.');
  await ensureBucket();
  const res = await fetch(`${c.url}/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
    method: 'POST',
    headers: headers(c.key, { 'content-type': contentType, 'x-upsert': 'true' }),
    body: Buffer.from(bytes),
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return `storage:${path}`;
}

/** Signature the laptop checks before serving an archived file (shared CRON_SECRET). */
export function archiveSignature(path: string, expires: number, secret = process.env.CRON_SECRET ?? ''): string {
  return createHmac('sha256', secret).update(`${path}\n${expires}`).digest('hex').slice(0, 32);
}

async function readArchived(path: string): Promise<Buffer | null> {
  const state = await controlDb().systemState.findUnique({ where: { id: 'main' }, select: { laptopUrl: true } }).catch(() => null);
  if (!state?.laptopUrl) return null;
  const expires = Date.now() + 5 * 60_000;
  const url = `${state.laptopUrl.replace(/\/+$/, '')}/api/archive/${encodePath(path)}?exp=${expires}&sig=${archiveSignature(path, expires)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  return res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

/**
 * Reads a stored reference (any of the forms above). Null when the file can't be fetched right
 * now — e.g. an archived file while the laptop is off.
 */
export async function readRef(ref: string): Promise<Buffer | null> {
  if (ref.startsWith('storage:')) {
    const c = config();
    if (!c) return null;
    const res = await fetch(`${c.url}/storage/v1/object/${BUCKET}/${encodePath(ref.slice(8))}`, { headers: headers(c.key) }).catch(() => null);
    return res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }
  if (ref.startsWith('archive:')) return readArchived(ref.slice(8));
  if (/^https?:\/\//.test(ref)) {
    const res = await fetch(ref, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    return res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }
  return Buffer.from(ref, 'base64');
}

/** A signed PDF, as base64 for the existing viewers; null if unavailable right now. */
export async function pdfBase64(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;
  if (!/^(storage|archive):|^https?:\/\//.test(stored)) return stored; // already inline base64
  const buf = await readRef(stored);
  return buf ? buf.toString('base64') : null;
}

/**
 * Stores a finished PDF: in Supabase Storage when set up (the laptop archives it later),
 * otherwise inline as base64 like before. Returns what to save in the database column.
 */
export async function storePdf(path: string, pdf: Buffer): Promise<string> {
  if (!storageEnabled()) return pdf.toString('base64');
  try {
    return await putFile(path, pdf, 'application/pdf');
  } catch (err) {
    console.error('[storage] PDF upload failed, keeping it inline', err);
    return pdf.toString('base64');
  }
}

export interface AttachmentMeta {
  url: string;
  name: string;
  contentType: string;
  size?: number;
}

/** Signing-request attachments as email attachments (unreadable ones are left out). */
export async function attachmentsForEmail(metas: AttachmentMeta[]): Promise<{ filename: string; mimeType: string; content: Buffer }[]> {
  const files = await Promise.all(
    metas.map(async (m) => {
      const content = await readRef(m.url).catch(() => null);
      return content ? { filename: m.name, mimeType: m.contentType, content } : null;
    }),
  );
  return files.filter((f): f is NonNullable<typeof f> => !!f);
}
