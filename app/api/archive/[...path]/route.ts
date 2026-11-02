import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { archiveSignature } from '@/lib/storage/files';

/**
 * Archived files (signed PDFs and signing attachments the laptop server took over from
 * Supabase Storage, lib/storage/files.ts). Served only on the laptop, where ARCHIVE_DIR is set,
 * and only to requests signed by the cloud app with the shared secret, valid for 5 minutes.
 * (On standby the laptop serves this path from laptop-server/start.mjs instead.)
 */
export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export async function GET(req: Request, { params }: { params: { path: string[] } }) {
  const root = process.env.ARCHIVE_DIR;
  if (!root) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rel = params.path.map(decodeURIComponent).join('/');
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  const expected = archiveSignature(rel, exp);
  const valid = Number.isFinite(exp) && exp > Date.now() && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const data = await fs.readFile(full).catch(() => null);
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(new Uint8Array(data), {
    headers: { 'content-type': TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'private, no-store' },
  });
}
