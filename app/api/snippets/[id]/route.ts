import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite, resolveWorkspaceId } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  html: z.string().min(1).max(50_000).optional(),
});

type Params = { params: { id: string } };

export const PATCH = withErrorHandling(async (req, { params }: Params) => {
  const session = await requireSession();
  requireCanWrite(session);
  const workspaceId = await resolveWorkspaceId(session);
  const existing = await prisma.replySnippet.findFirst({ where: { id: params.id, workspaceId } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = patchSchema.parse(await req.json());
  const snippet = await prisma.replySnippet.update({
    where: { id: existing.id },
    data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.html !== undefined ? { html: sanitizeEmailHtml(body.html) } : {}) },
  });
  await audit(session, 'SNIPPET_UPDATE', { targetType: 'ReplySnippet', targetId: snippet.id });
  return NextResponse.json({ snippet });
});

export const DELETE = withErrorHandling(async (_req, { params }: Params) => {
  const session = await requireSession();
  requireCanWrite(session);
  const workspaceId = await resolveWorkspaceId(session);
  const existing = await prisma.replySnippet.findFirst({ where: { id: params.id, workspaceId } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.replySnippet.delete({ where: { id: existing.id } });
  await audit(session, 'SNIPPET_DELETE', { targetType: 'ReplySnippet', targetId: existing.id, metadata: { name: existing.name } });
  return NextResponse.json({ ok: true });
});
