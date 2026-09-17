import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';
import { generateSignedPdf } from '@/lib/documents/pdf';

// Public route — no requireSession() calls.

/**
 * GET /api/sign/[token] — public endpoint for a signer to view the document.
 * No authentication required.
 */
export const GET = withErrorHandling(async (_req, { params }: { params: { token: string } }) => {
  const request = await prisma.signingRequest.findUnique({
    where: { token: params.token },
  });

  if (!request || request.status === 'VOIDED') {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const now = new Date();
  if (request.status === 'EXPIRED' || (request.expiresAt && request.expiresAt < now)) {
    if (request.status !== 'EXPIRED') {
      await prisma.signingRequest.update({
        where: { id: request.id },
        data: { status: 'EXPIRED' },
      });
    }
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }

  // Mark as VIEWED on first open
  if (request.status === 'SENT') {
    await prisma.signingRequest.update({
      where: { id: request.id },
      data: { status: 'VIEWED', viewedAt: now },
    });
  }

  return NextResponse.json({
    id: request.id,
    title: request.title,
    content: request.content,
    recipientName: request.recipientName,
    fieldValues: request.fieldValues,
    status: request.status === 'SENT' ? 'VIEWED' : request.status,
    expiresAt: request.expiresAt,
    // Include signed PDF for already-signed docs so signers can re-download
    signedPdfData: request.status === 'SIGNED' ? request.signedPdfData : null,
  });
});

const submitSchema = z.object({
  signatureImage: z.string().min(1),
  signerName: z.string().min(1).max(200),
  fieldValues: z.record(z.string()).optional(),
});

/**
 * POST /api/sign/[token] — public endpoint for a signer to submit their signature.
 * No authentication required.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { token: string } }) => {
  const request = await prisma.signingRequest.findUnique({
    where: { token: params.token },
  });

  if (!request) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  if (request.status === 'SIGNED' || request.status === 'VOIDED' || request.status === 'EXPIRED') {
    return NextResponse.json(
      { error: `Document is already ${request.status.toLowerCase()}.` },
      { status: 409 }
    );
  }

  // Check expiry
  const now = new Date();
  if (request.expiresAt && request.expiresAt < now) {
    await prisma.signingRequest.update({
      where: { id: request.id },
      data: { status: 'EXPIRED' },
    });
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }

  const body = submitSchema.parse(await req.json());

  // Merge admin pre-fills with student-submitted values (student values win)
  const mergedFieldValues: Record<string, string> = {
    ...((request.fieldValues as Record<string, string>) ?? {}),
    ...(body.fieldValues ?? {}),
  };

  const signerIp =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';
  const signerAgent = req.headers.get('user-agent') ?? 'unknown';

  // Generate signed PDF with merged field values
  const pdfBuffer = await generateSignedPdf({
    title: request.title,
    content: request.content,
    recipientName: request.recipientName,
    recipientEmail: request.recipientEmail,
    fieldValues: mergedFieldValues,
    signatureImage: body.signatureImage,
    signedAt: now,
    signerIp,
  });

  const signedPdfBase64 = pdfBuffer.toString('base64');

  // Persist the signature
  await prisma.signingRequest.update({
    where: { id: request.id },
    data: {
      status: 'SIGNED',
      signedAt: now,
      signatureImage: body.signatureImage,
      signedPdfData: signedPdfBase64,
      fieldValues: mergedFieldValues,
      signerIp,
      signerAgent,
    },
  });

  // Retrieve workspace email account for sending confirmations
  const account = await prisma.emailProviderAccount.findFirst({
    where: { workspaceId: request.workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  const pdfFilename = `${request.title.replace(/\s+/g, '_')}_signed.pdf`;
  const pdfAttachment = {
    filename: pdfFilename,
    mimeType: 'application/pdf',
    content: pdfBuffer,
  };

  if (account) {
    const signedDateStr = now.toUTCString();

    // Confirmation email to recipient
    const recipientHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#059669;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">Document Signed</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;margin-top:0;">Hi ${request.recipientName},</p>
    <p style="font-size:15px;">
      You've successfully signed <strong>${request.title}</strong>.
      A copy of the signed document is attached to this email for your records.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;font-size:13px;color:#6b7280;">Signed on: <strong>${signedDateStr}</strong></p>
    </div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="font-size:12px;color:#9ca3af;margin:0;">placements@masaischool.com</p>
  </div>
</body>
</html>`;

    // Notification email to team (first CC email or fallback)
    const notifyTo: string =
      (request.ccEmails.length > 0 ? request.ccEmails[0] : null) ?? 'placements@masaischool.com';
    const remainingCc = request.ccEmails.length > 1 ? request.ccEmails.slice(1) : [];

    const teamHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#1a56db;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">MailFlow · Signing Notification</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;margin-top:0;">
      <strong>${request.recipientName}</strong> has signed <strong>${request.title}</strong>.
    </p>
    <table style="font-size:13px;border-collapse:collapse;width:100%;">
      <tr>
        <td style="padding:6px 0;color:#6b7280;width:140px;">Signer name</td>
        <td style="padding:6px 0;">${request.recipientName}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#6b7280;">Signer email</td>
        <td style="padding:6px 0;">${request.recipientEmail}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#6b7280;">Signed at</td>
        <td style="padding:6px 0;">${signedDateStr}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#6b7280;">IP address</td>
        <td style="padding:6px 0;">${signerIp}</td>
      </tr>
    </table>
    <p style="font-size:13px;color:#6b7280;margin-top:16px;">
      The signed document is attached to this email.
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="font-size:12px;color:#9ca3af;margin:0;">MailFlow · placements@masaischool.com</p>
  </div>
</body>
</html>`;

    try {
      await Promise.allSettled([
        new GmailProvider(account).sendEmail({
          to: request.recipientEmail,
          fromName: account.displayName || 'MailFlow',
          fromEmail: account.emailAddress,
          subject: `Document Signed: ${request.title}`,
          html: recipientHtml,
          attachments: [pdfAttachment],
        }),
        new GmailProvider(account).sendEmail({
          to: notifyTo,
          cc: remainingCc.length > 0 ? remainingCc : undefined,
          fromName: account.displayName || 'MailFlow',
          fromEmail: account.emailAddress,
          subject: `[Signed] ${request.recipientName} has signed: ${request.title}`,
          html: teamHtml,
          attachments: [pdfAttachment],
        }),
      ]);
    } catch (err) {
      console.error('[sign] failed to send confirmation emails', err);
    }
  }

  // Audit log — resolve organizationId from the workspace
  const workspace = await prisma.workspace.findUnique({
    where: { id: request.workspaceId },
    select: { organizationId: true },
  });

  if (workspace) {
    await audit(
      { organizationId: workspace.organizationId },
      'SIGNING_REQUEST_SIGNED',
      {
        targetType: 'SigningRequest',
        targetId: request.id,
        metadata: { signerIp, signerAgent, signedAt: now.toISOString() },
      }
    );
  }

  return NextResponse.json({ signed: true });
});
