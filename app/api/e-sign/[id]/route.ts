import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';

/** GET /api/e-sign/[id] — fetch a single signing request for the current workspace. */
export const GET = withErrorHandling(async (_req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const request = await prisma.signingRequest.findFirst({
    where: { id: params.id, workspaceId: session.workspaceId },
    include: { sentBy: { select: { name: true, email: true } } },
  });

  if (!request) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  return NextResponse.json({ request });
});

const patchSchema = z.object({
  action: z.enum(['void', 'resend']),
});

/** PATCH /api/e-sign/[id] — void or resend a signing request. */
export const PATCH = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }
  const workspaceId = session.workspaceId;

  const body = patchSchema.parse(await req.json());

  const existing = await prisma.signingRequest.findFirst({
    where: { id: params.id, workspaceId },
  });
  if (!existing) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  if (body.action === 'void') {
    const updated = await prisma.signingRequest.update({
      where: { id: existing.id },
      data: { status: 'VOIDED', voidedAt: new Date() },
    });
    await audit(session, 'SIGNING_REQUEST_VOIDED', {
      targetType: 'SigningRequest',
      targetId: existing.id,
    });
    return NextResponse.json({ request: updated });
  }

  // action === 'resend'
  const now = new Date();
  const updated = await prisma.signingRequest.update({
    where: { id: existing.id },
    data: { sentAt: now },
  });

  const account = await prisma.emailProviderAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  if (account) {
    const signingUrl = `${process.env.NEXTAUTH_URL}/sign/${existing.token}`;
    const expiresDateStr = existing.expiresAt
      ? existing.expiresAt.toLocaleDateString('en-IN', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : 'N/A';

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#1a56db;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">MailFlow · Masai School</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;margin-top:0;">Hi ${existing.recipientName},</p>
    <p style="font-size:15px;">This is a reminder that the following document is awaiting your signature.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Document</p>
      <p style="margin:6px 0 0;font-size:18px;font-weight:600;color:#111;">${existing.title}</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signingUrl}"
         style="background:#1a56db;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
        Review &amp; Sign Document
      </a>
    </div>
    <p style="font-size:13px;color:#6b7280;margin-bottom:4px;">
      This link expires on <strong>${expiresDateStr}</strong>.
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="font-size:12px;color:#9ca3af;margin:0;">
      Sent by ${session.name} &middot; placements@masaischool.com
    </p>
  </div>
</body>
</html>`;

    try {
      await new GmailProvider(account).sendEmail({
        to: existing.recipientEmail,
        cc: existing.ccEmails.length > 0 ? existing.ccEmails : undefined,
        fromName: account.displayName || session.name,
        fromEmail: account.emailAddress,
        subject: `[Reminder] Please sign: ${existing.title}`,
        html,
      });
    } catch (err) {
      console.error('[e-sign] failed to resend invitation email', err);
    }
  }

  await audit(session, 'SIGNING_REQUEST_RESENT', {
    targetType: 'SigningRequest',
    targetId: existing.id,
  });

  return NextResponse.json({ request: updated });
});
