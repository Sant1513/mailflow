import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { buildBody } from '@/lib/recruiterSend/core';
import { readVideo, signedVideoUpload, VIDEO_MAX_BYTES, VIDEO_TYPES } from '@/lib/recruiterSend/video';

/**
 * Attaching a video to a draft recruiter send. The browser uploads the file straight to
 * Supabase Storage (POST {step:"start"} returns a one-time upload link), then confirms
 * (POST {step:"done"}). DELETE removes the video (attached or link).
 */
export const dynamic = 'force-dynamic';

const startSchema = z.object({ step: z.literal('start'), fileName: z.string().min(1).max(200), size: z.number().int().positive(), contentType: z.string().max(100) });
const doneSchema = z.object({ step: z.literal('done'), ref: z.string().startsWith('storage:'), fileName: z.string().max(200), size: z.number().int().positive(), contentType: z.string().max(100) });

export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'Only a draft can change its video.' }, { status: 409 });
  const raw = await req.json().catch(() => null);

  if (raw?.step === 'start') {
    const b = startSchema.parse(raw);
    if (!VIDEO_TYPES.includes(b.contentType)) return NextResponse.json({ error: 'Use an MP4, MOV, WebM, AVI or MKV video.' }, { status: 400 });
    if (b.size > VIDEO_MAX_BYTES) {
      return NextResponse.json({ error: `That video is ${(b.size / 1048576).toFixed(1)} MB. Attachments can be up to ${VIDEO_MAX_BYTES / 1048576} MB — for a bigger one, upload it to Google Drive or YouTube and add it as a link.` }, { status: 400 });
    }
    const safe = b.fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    try {
      const { uploadUrl, ref } = await signedVideoUpload(`recruiter-videos/${blast.workspaceId}/${blast.id}/${Date.now()}-${safe}`);
      return NextResponse.json({ uploadUrl, ref });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 503 });
    }
  }

  const b = doneSchema.parse(raw);
  if (!b.ref.startsWith(`storage:recruiter-videos/${blast.workspaceId}/${blast.id}/`)) return NextResponse.json({ error: 'That upload does not belong to this send.' }, { status: 400 });
  const video = { mode: 'attach' as const, ref: b.ref, fileName: b.fileName, size: b.size, contentType: b.contentType };
  // An attached video replaces a link video's button in the body.
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { emailSignature: true } });
  const built = buildBody({ body: blast.body, format: blast.format, signature: blast.includeSignature && me?.emailSignature?.trim() ? me.emailSignature : null });
  await prisma.recruiterBlast.update({ where: { id: blast.id }, data: { video: video as unknown as Prisma.InputJsonValue, html: built.html, plainText: built.plainText } });
  return NextResponse.json({ video });
});

export const DELETE = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (blast.status !== 'DRAFT') return NextResponse.json({ error: 'Only a draft can change its video.' }, { status: 409 });
  const had = readVideo(blast.video);
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { emailSignature: true } });
  const built = buildBody({ body: blast.body, format: blast.format, signature: blast.includeSignature && me?.emailSignature?.trim() ? me.emailSignature : null });
  await prisma.recruiterBlast.update({ where: { id: blast.id }, data: { video: Prisma.JsonNull, html: built.html, plainText: built.plainText } });
  return NextResponse.json({ ok: true, removed: had?.mode ?? null });
});
