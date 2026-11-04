import { z } from 'zod';
import { BUCKET, storageEnabled } from '@/lib/storage/files';

/**
 * Videos in recruiter sends.
 *   attach — a small video (≤ 20 MB) uploaded straight from the browser to Supabase Storage
 *            (Vercel caps uploads through the app at 4.5 MB) and attached to each message.
 *   link   — any size: a Google Drive / YouTube link shown as a "Watch the video" button (with
 *            the YouTube thumbnail when it is a YouTube link). Free and uses no storage.
 * Attaching costs one download from storage per message, so individual copies with an
 * attached video are capped (VIDEO_INDIVIDUAL_MAX) to stay inside the free data allowance.
 */
export const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_INDIVIDUAL_MAX = 50;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg'];

export const videoSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('attach'),
    ref: z.string().startsWith('storage:'),
    fileName: z.string().max(200),
    size: z.number().int().positive().max(VIDEO_MAX_BYTES),
    contentType: z.string().max(100),
  }),
  z.object({
    mode: z.literal('link'),
    url: z.string().url().max(2000).refine((u) => /^https:\/\//.test(u), 'Use an https link'),
    title: z.string().trim().max(120).default('Watch the video'),
  }),
]);
export type BlastVideo = z.infer<typeof videoSchema>;

export function readVideo(value: unknown): BlastVideo | null {
  const parsed = videoSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m?.[1] ?? null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Email-safe "Watch the video" block for a link video. */
export function videoLinkCard(url: string, title: string): string {
  const yt = youtubeId(url);
  const thumb = yt
    ? `<a href="${esc(url)}" target="_blank" style="display:block;text-decoration:none;"><img src="https://img.youtube.com/vi/${yt}/hqdefault.jpg" width="480" alt="${esc(title)}" style="display:block;width:100%;max-width:480px;height:auto;border:0;border-radius:8px;" /></a>`
    : '';
  return `<div style="margin:20px 0;">${thumb}<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:${thumb ? '10px' : '0'};"><tr><td bgcolor="#111827" style="background:#111827;border-radius:6px;"><a href="${esc(url)}" target="_blank" style="display:inline-block;padding:11px 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">&#9654;&nbsp;${esc(title || 'Watch the video')}</a></td></tr></table></div>`;
}

/**
 * A one-time link the browser uploads the video to, directly in Supabase Storage.
 * Returns { uploadUrl, ref } or throws when storage isn't set up.
 */
export async function signedVideoUpload(path: string): Promise<{ uploadUrl: string; ref: string }> {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !storageEnabled()) throw new Error('File storage is not set up yet (SUPABASE_URL / SUPABASE_SERVICE_KEY), so videos can only be added as a link for now.');
  // Make sure the private bucket exists (same one as signing files).
  await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  }).catch(() => undefined);
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${url}/storage/v1/object/upload/sign/${BUCKET}/${encoded}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Could not prepare the upload (${res.status}).`);
  const j = (await res.json()) as { url?: string; token?: string };
  const signed = j.url ? `${url}/storage/v1${j.url.startsWith('/') ? '' : '/'}${j.url}` : `${url}/storage/v1/object/upload/sign/${BUCKET}/${encoded}?token=${j.token}`;
  return { uploadUrl: signed, ref: `storage:${path}` };
}
