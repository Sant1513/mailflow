import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';
import type { Prisma } from '@prisma/client';

const PAGE_SIZE = 20;

/** GET /api/e-sign — list signing requests for the current workspace. */
export const GET = withErrorHandling(async (req) => {
  const session = await requireSession();
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }
  const workspaceId = session.workspaceId;

  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? undefined;
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));

  const where: Prisma.SigningRequestWhereInput = {
    workspaceId,
    ...(status ? { status: status as any } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' as const } },
            { recipientName: { contains: search, mode: 'insensitive' as const } },
            { recipientEmail: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [requests, total] = await Promise.all([
    prisma.signingRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        recipientName: true,
        recipientEmail: true,
        status: true,
        expiresAt: true,
        sentAt: true,
        viewedAt: true,
        signedAt: true,
        voidedAt: true,
        ccEmails: true,
        token: true,
        createdAt: true,
        updatedAt: true,
        sentBy: { select: { name: true, email: true } },
      },
    }),
    prisma.signingRequest.count({ where }),
  ]);

  return NextResponse.json({ requests, total, page });
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email(),
  fieldValues: z.record(z.string()).default({}),
  ccEmails: z.array(z.string().email()).default([]),
  expiresInDays: z.number().int().min(1).max(365).default(7),
});

/** POST /api/e-sign — create and send a new signing request. */
export const POST = withErrorHandling(async (req) => {
  const session = await requireSession();
  requireCanWrite(session);
  if (!session.workspaceId) {
    return NextResponse.json({ error: 'No workspace.' }, { status: 403 });
  }
  const workspaceId = session.workspaceId;

  const body = createSchema.parse(await req.json());

  const now = new Date();
  const expiresAt = new Date(now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000);

  const request = await prisma.signingRequest.create({
    data: {
      workspaceId,
      title: body.title,
      content: body.content,
      recipientName: body.recipientName,
      recipientEmail: body.recipientEmail,
      fieldValues: body.fieldValues,
      ccEmails: body.ccEmails,
      status: 'SENT',
      sentAt: now,
      expiresAt,
      sentById: session.userId,
    },
  });

  // Send signing invitation email
  const account = await prisma.emailProviderAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  if (account) {
    const signingUrl = `${process.env.NEXTAUTH_URL}/sign/${request.token}`;
    const expiresDateStr = expiresAt.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#1a56db;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">MailFlow · Masai School</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;margin-top:0;">Hi ${body.recipientName},</p>
    <p style="font-size:15px;">You've received a document that requires your signature.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Document</p>
      <p style="margin:6px 0 0;font-size:18px;font-weight:600;color:#111;">${body.title}</p>
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
      Sent by ${session.name} &middot; placements@masaischool.com
    </p>
  </div>
</body>
</html>`;

    try {
      await new GmailProvider(account).sendEmail({
        to: body.recipientEmail,
        cc: body.ccEmails.length > 0 ? body.ccEmails : undefined,
        fromName: account.displayName || session.name,
        fromEmail: account.emailAddress,
        subject: `[Action Required] Please sign: ${body.title}`,
        html,
      });
    } catch (err) {
      console.error('[e-sign] failed to send invitation email', err);
    }
  }

  await audit(session, 'SIGNING_REQUEST_SENT', {
    targetType: 'SigningRequest',
    targetId: request.id,
  });

  return NextResponse.json({ request }, { status: 201 });
});
