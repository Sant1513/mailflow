import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { loadBlast, requireBlastAdmin, sendableMailboxes } from '@/lib/recruiterSend/access';

/** Copy a recruiter send into a new draft: same recruiters, email, mailboxes and settings. */
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const source = await loadBlast(session, params.id);
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Keep only mailboxes this admin may still use.
  const allowed = new Set((await sendableMailboxes(session)).map((m) => m.id));
  const accountIds = source.accountIds.filter((id) => allowed.has(id));
  const limits = (source.accountLimits && typeof source.accountLimits === 'object' ? source.accountLimits : {}) as Record<string, number>;

  const copy = await prisma.recruiterBlast.create({
    data: {
      organizationId: session.organizationId,
      workspaceId: session.workspaceId!,
      createdById: session.userId,
      name: `Copy of ${source.name}`.slice(0, 200),
      mode: source.mode,
      toAddress: source.toAddress,
      subject: source.subject,
      html: source.html,
      plainText: source.plainText,
      body: source.body,
      format: source.format,
      includeSignature: source.includeSignature,
      fromName: source.fromName,
      replyTo: source.replyTo,
      accountIds,
      accountLimits: Object.fromEntries(Object.entries(limits).filter(([id]) => accountIds.includes(id))),
      video: source.video === null ? Prisma.JsonNull : (source.video as Prisma.InputJsonValue),
      attachmentDocumentIds: source.attachmentDocumentIds,
      groupSize: source.groupSize,
      gapSeconds: source.gapSeconds,
      copiedFromId: source.id,
    },
  });
  const recipients = await prisma.recruiterBlastRecipient.findMany({ where: { blastId: source.id }, select: { email: true, name: true } });
  for (let i = 0; i < recipients.length; i += 1000) {
    await prisma.recruiterBlastRecipient.createMany({ data: recipients.slice(i, i + 1000).map((r) => ({ blastId: copy.id, email: r.email, name: r.name })), skipDuplicates: true });
  }
  await audit(session, 'RECRUITER_SEND_COPY', { targetType: 'RecruiterBlast', targetId: copy.id, metadata: { from: source.id } });
  return NextResponse.json({ id: copy.id });
});
