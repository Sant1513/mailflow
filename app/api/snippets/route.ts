import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite, resolveWorkspaceId } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';
import { renderSnippet } from '@/lib/snippets/render';

/**
 * §4.1 saved replies, per workspace. `?conversationId=` returns each snippet
 * also rendered for that conversation's student, so the composer can insert
 * "Hi Rahul" instead of "Hi {{Name}}".
 */
const bodySchema = z.object({
  name: z.string().min(1).max(100),
  html: z.string().min(1).max(50_000),
});

export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  const url = new URL(req.url);
  const workspaceId = await resolveWorkspaceId(session);
  const conversationId = url.searchParams.get('conversationId');

  const snippets = await prisma.replySnippet.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } });

  let ctx: Parameters<typeof renderSnippet>[1] | null = null;
  if (conversationId) {
    const c = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { recipientEmail: true, contact: { select: { name: true, records: { take: 1, orderBy: { updatedAt: 'desc' }, select: { data: true } } } } },
    });
    if (c) {
      ctx = {
        contactName: c.contact.name,
        contactEmail: c.recipientEmail,
        senderName: session.name,
        record: (c.contact.records[0]?.data as Record<string, unknown> | undefined) ?? null,
      };
    }
  }

  return NextResponse.json({
    snippets: snippets.map((s) => {
      const rendered = ctx ? renderSnippet(s.html, ctx) : null;
      return { id: s.id, name: s.name, html: s.html, rendered: rendered?.html ?? null, missing: rendered?.missing ?? [] };
    }),
  });
});

export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  const workspaceId = await resolveWorkspaceId(session);
  const body = bodySchema.parse(await req.json());
  const snippet = await prisma.replySnippet.create({
    data: { workspaceId, createdById: session.userId, name: body.name, html: sanitizeEmailHtml(body.html) },
  });
  await audit(session, 'SNIPPET_CREATE', { targetType: 'ReplySnippet', targetId: snippet.id, metadata: { name: body.name } });
  return NextResponse.json({ snippet }, { status: 201 });
});
