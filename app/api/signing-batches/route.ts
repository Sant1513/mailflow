import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';

/** GET /api/signing-batches — list batches for the current workspace. */
export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }

  const batches = await prisma.signingBatch.findMany({
    where: { workspaceId: session.workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { template: { select: { title: true } } },
  });

  return NextResponse.json({ batches });
});

const recipientSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  fieldValues: z.record(z.string()).optional().default({}),
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  templateId: z.string().optional(),
  recipients: z.array(recipientSchema).min(1).max(200),
  ccEmails: z.array(z.string().email()).default(['placements@masaischool.com']),
  expiresInDays: z.number().int().min(1).max(365).default(7),
});

/** POST /api/signing-batches — create a batch and send signing requests. */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }
  const workspaceId = session.workspaceId;

  const body = createSchema.parse(await req.json());

  // Look up template content if templateId is provided
  let templateContent: string | null = null;
  if (body.templateId) {
    const tpl = await prisma.signingTemplate.findFirst({
      where: { id: body.templateId, workspaceId },
    });
    if (!tpl) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 });
    }
    templateContent = tpl.content;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000);

  // Create the batch record
  const batch = await prisma.signingBatch.create({
    data: {
      workspaceId,
      templateId: body.templateId ?? null,
      title: body.title,
      totalCount: body.recipients.length,
      createdById: session.userId,
    },
  });

  // Create a SigningRequest for each recipient
  const requests = await Promise.all(
    body.recipients.map((r) =>
      prisma.signingRequest.create({
        data: {
          workspaceId,
          batchId: batch.id,
          title: body.title,
          content: templateContent ?? '<p>Please sign this document.</p>',
          recipientName: r.name,
          recipientEmail: r.email,
          fieldValues: r.fieldValues,
          ccEmails: body.ccEmails,
          status: 'SENT',
          sentAt: now,
          expiresAt,
          sentById: session.userId,
        },
      }),
    ),
  );

  // Get the workspace email account for sending
  const account = await prisma.emailProviderAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  let sentCount = 0;

  if (account) {
    const expiresDateStr = expiresAt.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // Send invitation emails in parallel — allSettled so one failure doesn't abort the rest
    const results = await Promise.allSettled(
      requests.map((sigReq) => {
        const signingUrl = `${process.env.NEXTAUTH_URL}/sign/${sigReq.token}`;
        const html = buildInviteHtml({
          recipientName: sigReq.recipientName,
          title: body.title,
          signingUrl,
          expiresDateStr,
          senderName: session.name,
        });
        return new GmailProvider(account).sendEmail({
          to: sigReq.recipientEmail,
          cc: body.ccEmails.length > 0 ? body.ccEmails : undefined,
          fromName: account.displayName || session.name,
          fromEmail: account.emailAddress,
          subject: `[Action Required] Please sign: ${body.title}`,
          html,
        });
      }),
    );

    sentCount = results.filter((r) => r.status === 'fulfilled').length;

    const failedCount = results.length - sentCount;
    if (failedCount > 0) {
      console.error(`[signing-batches] ${failedCount} email(s) failed to send for batch ${batch.id}`);
    }
  }

  // Update sentCount on the batch
  await prisma.signingBatch.update({
    where: { id: batch.id },
    data: { sentCount },
  });

  await audit(session, 'SIGNING_BATCH_SENT', {
    targetType: 'SigningBatch',
    targetId: batch.id,
    metadata: { batchId: batch.id, totalCount: body.recipients.length },
  });

  const fullBatch = await prisma.signingBatch.findUnique({
    where: { id: batch.id },
    include: {
      template: { select: { title: true } },
      requests: {
        select: {
          id: true,
          recipientName: true,
          recipientEmail: true,
          status: true,
          sentAt: true,
          signedAt: true,
          token: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  return NextResponse.json({ batch: fullBatch }, { status: 201 });
});

function buildInviteHtml({
  recipientName,
  title,
  signingUrl,
  expiresDateStr,
  senderName,
}: {
  recipientName: string;
  title: string;
  signingUrl: string;
  expiresDateStr: string;
  senderName: string;
}): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#1a56db;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">MailFlow · Masai School</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;margin-top:0;">Hi ${recipientName},</p>
    <p style="font-size:15px;">You've received a document that requires your signature.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Document</p>
      <p style="margin:6px 0 0;font-size:18px;font-weight:600;color:#111;">${title}</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${signingUrl}"
         style="background:#1a56db;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
        Review &amp; Sign Document
      </a>
    </div>
    <p style="font-size:13px;color:#6b7280;margin-bottom:4px;">
      This link expires on <strong>${expiresDateStr}</strong>. After that date, the document can no longer be signed.
    </p>
    <p style="font-size:13px;color:#6b7280;">
      If you believe you received this in error, you can safely ignore this email.
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="font-size:12px;color:#9ca3af;margin:0;">
      Sent by ${senderName} &middot; placements@masaischool.com
    </p>
  </div>
</body>
</html>`;
}
