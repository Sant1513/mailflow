import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { GmailProvider } from '@/lib/email/gmail';
import { appUrl } from '@/lib/campaigns/approvalEmails';

/**
 * Daily cron: sends reminder emails for SigningRequests that are SENT or
 * VIEWED, not yet expired, older than 2 days, and have fewer than 3
 * reminders. At most one reminder per 2-day window (reminderSentAt guard).
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}` || new URL(req.url).searchParams.get('secret') === secret;
}

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const requests = await prisma.signingRequest.findMany({
    where: {
      status: { in: ['SENT', 'VIEWED'] },
      expiresAt: { gt: now },
      sentAt: { lt: twoDaysAgo },
      reminderCount: { lt: 3 },
      OR: [
        { reminderSentAt: null },
        { reminderSentAt: { lt: twoDaysAgo } },
      ],
    },
    take: 100,
  });

  if (requests.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  // Group by workspaceId to batch email account lookups
  const workspaceIds = [...new Set(requests.map((r) => r.workspaceId))];
  const accounts = await prisma.emailProviderAccount.findMany({
    where: { workspaceId: { in: workspaceIds } },
    orderBy: { createdAt: 'asc' },
  });
  const accountByWorkspace = new Map<string, typeof accounts[0]>();
  for (const account of accounts) {
    if (!accountByWorkspace.has(account.workspaceId)) {
      accountByWorkspace.set(account.workspaceId, account);
    }
  }

  let processed = 0;

  for (const request of requests) {
    const account = accountByWorkspace.get(request.workspaceId);
    if (!account || account.status !== 'CONNECTED') continue;

    const signingUrl = appUrl(`/sign/${request.token}`);
    const expiresAt = request.expiresAt!;
    const urgentExpiry = expiresAt < oneDayFromNow;

    const expiresDateStr = expiresAt.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const urgencyNote = urgentExpiry
      ? `<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px 16px;color:#dc2626;font-weight:600;margin:16px 0;">
           ⚠️ This link expires tomorrow. Please sign before ${expiresDateStr}.
         </p>`
      : `<p style="font-size:13px;color:#6b7280;">
           This link expires on <strong>${expiresDateStr}</strong>.
         </p>`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#1a56db;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">MailFlow · Masai School</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;margin-top:0;">Hi ${request.recipientName},</p>
    <p style="font-size:15px;">This is a reminder that a document is waiting for your signature.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Document</p>
      <p style="margin:6px 0 0;font-size:18px;font-weight:600;color:#111;">${request.title}</p>
    </div>
    ${urgencyNote}
    <div style="text-align:center;margin:28px 0;">
      <a href="${signingUrl}"
         style="background:#1a56db;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
        Review &amp; Sign Document
      </a>
    </div>
    <p style="font-size:13px;color:#6b7280;">
      If you believe you received this in error, you can safely ignore this email.
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="font-size:12px;color:#9ca3af;margin:0;">
      Sent by MailFlow · placements@masaischool.com
    </p>
  </div>
</body>
</html>`;

    try {
      await new GmailProvider(account).sendEmail({
        to: request.recipientEmail,
        cc: request.ccEmails.length > 0 ? request.ccEmails : undefined,
        fromName: account.displayName || 'Masai School',
        fromEmail: account.emailAddress,
        subject: `Reminder: ${request.title} is waiting for your signature`,
        html,
      });

      await prisma.signingRequest.update({
        where: { id: request.id },
        data: {
          reminderSentAt: now,
          reminderCount: { increment: 1 },
        },
      });

      processed++;
    } catch (err) {
      console.error('[signing-reminders] failed to send reminder', { requestId: request.id, err });
    }
  }

  return NextResponse.json({ processed });
}
