import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';
import { loadBlast, requireBlastAdmin } from '@/lib/recruiterSend/access';
import { readVideo } from '@/lib/recruiterSend/video';
import { replyToHeader } from '@/lib/recruiterSend/core';
import { sendViaUpload, UPLOAD_THRESHOLD_BYTES } from '@/lib/recruiterSend/gmailUpload';
import { readRef } from '@/lib/storage/files';
import type { EmailAttachment } from '@/lib/email/provider';

/** Sends one test copy of a recruiter send to the admin, from the first connected chosen mailbox. */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireBlastAdmin();
  const blast = await loadBlast(session, params.id);
  if (!blast) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!blast.subject.trim() || !blast.body.trim()) return NextResponse.json({ error: 'Add a subject and a message first.' }, { status: 400 });

  const accounts = blast.accountIds.length ? await prisma.emailProviderAccount.findMany({ where: { id: { in: blast.accountIds }, status: 'CONNECTED' } }) : [];
  const account = blast.accountIds.map((id) => accounts.find((a) => a.id === id)).find((a) => !!a);
  if (!account) return NextResponse.json({ error: 'Choose a connected mailbox to send from.' }, { status: 400 });

  const docs = blast.attachmentDocumentIds.length
    ? await prisma.documentTemplate.findMany({ where: { id: { in: blast.attachmentDocumentIds }, workspaceId: blast.workspaceId, archived: false }, select: { fileNamePattern: true, file: { select: { data: true } } } })
    : [];
  const attachments: EmailAttachment[] = docs.map((d) => ({ filename: /\.pdf$/i.test(d.fileNamePattern) ? d.fileNamePattern : `${d.fileNamePattern}.pdf`, mimeType: 'application/pdf', content: Buffer.from(d.file.data) }));
  const video = readVideo(blast.video);
  if (video?.mode === 'attach') {
    const bytes = await readRef(video.ref);
    if (!bytes) return NextResponse.json({ error: 'The video could not be read from storage.' }, { status: 502 });
    attachments.push({ filename: video.fileName, mimeType: video.contentType, content: bytes });
  }

  const note = `<p style="font-size:12px;color:#888;border:1px dashed #ccc;padding:6px 8px">Test of a recruiter send (${blast.mode === 'BCC' ? `BCC groups, visible To: ${blast.toAddress ?? '—'}` : 'individual copies'}${blast.ccAddresses.length ? `; CC on the real send: ${blast.ccAddresses.join(', ')} (not copied on this test)` : ''}). Recruiters won't see this note.</p>`;
  const input = {
    to: session.email,
    fromName: blast.fromName || account.displayName || account.emailAddress,
    fromEmail: account.emailAddress,
    replyTo: replyToHeader(blast.replyTo, account.emailAddress),
    subject: `[Test] ${blast.subject}`,
    html: `${note}${blast.html}`,
    plainText: blast.plainText,
    attachments,
  };
  try {
    const bytes = attachments.reduce((n, a) => n + a.content.length, 0);
    if (bytes > UPLOAD_THRESHOLD_BYTES) await sendViaUpload(account, input);
    else await new GmailProvider(account).sendEmail(input);
  } catch (err) {
    return NextResponse.json({ error: `The test could not be sent: ${(err as Error).message}` }, { status: 502 });
  }
  await audit(session, 'RECRUITER_SEND_TEST', { targetType: 'RecruiterBlast', targetId: blast.id, metadata: { to: session.email, from: account.emailAddress } });
  return NextResponse.json({ ok: true, to: session.email, from: account.emailAddress });
});
