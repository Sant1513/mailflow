import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { loadBlast, requireBlastReader } from '@/lib/recruiterSend/access';
import { decorate, type BlastMode } from '@/lib/recruiterSend/core';
import { personalize, squash, valuesOf, variablesIn } from '@/lib/recruiterSend/personalize';
import { sanitizeEmailHtml } from '@/lib/templates/sanitize';

/**
 * One recruiter's own email (Who receives this → click a row, and the progress list): the
 * subject and message with their {{Column}} values, the unsubscribe line with their address,
 * which values were used (and which are empty), and — once started — the batch and mailbox it
 * went from. A send can't be edited after it starts, so after sending this is exactly what
 * they got. No tracking pixel, so looking never counts as an open.
 */
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireBlastReader();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const email = (new URL(req.url).searchParams.get('email') ?? '').trim().toLowerCase();
  const r = await prisma.recruiterBlastRecipient.findUnique({
    where: { blastId_email: { blastId: blast.id, email } },
    select: { email: true, name: true, data: true, status: true, skipReason: true, sentAt: true, group: { select: { seq: true, status: true, fromEmail: true, plannedAccountId: true } } },
  });
  if (!r) return NextResponse.json({ error: 'That recruiter is not in this send.' }, { status: 404 });

  const mode = blast.mode as BlastMode;
  const used = variablesIn(blast.subject, blast.html);
  // Only individual copies are personalised (a BCC email is one message for many people).
  const personal = mode === 'INDIVIDUAL' && used.length > 0;
  const p = personal ? personalize(blast, r) : { subject: blast.subject, html: blast.html, resolved: {} as Record<string, string> };
  const html = blast.html ? decorate(p.html, { groupId: 'preview', mode, workspaceId: blast.workspaceId, blastId: blast.id, recipientEmail: r.email, pixel: false }).html : '';
  const values = valuesOf(r);
  const planned = r.group?.plannedAccountId
    ? await prisma.emailProviderAccount.findUnique({ where: { id: r.group.plannedAccountId }, select: { emailAddress: true } })
    : null;
  const row = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? Object.entries(r.data as Record<string, unknown>).slice(0, 40).map(([k, v]) => [k, v == null ? '' : String(v)]) : [];

  return NextResponse.json({
    email: r.email,
    name: r.name,
    personal,
    subject: p.subject,
    html: sanitizeEmailHtml(html),
    values: used.map((v) => {
      const value = values.get(squash(v.name)) ?? '';
      return { name: v.name, value: personal ? p.resolved[v.name] ?? value : value, empty: !value, fallback: v.fallback };
    }),
    row,
    status: r.status,
    skipReason: r.skipReason,
    sentAt: r.sentAt,
    batch: r.group?.seq ?? null,
    from: r.group?.fromEmail ?? planned?.emailAddress ?? null,
  });
});
