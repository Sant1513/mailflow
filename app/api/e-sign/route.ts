import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';
import type { EmailAttachment } from '@/lib/email/provider';
import type { Prisma } from '@prisma/client';
import { signaturePlacementsSchema } from '@/lib/signing/placements';

interface AttachmentMeta { name: string; url: string; contentType: string; size: number; }

async function fetchEmailAttachments(metas: AttachmentMeta[]): Promise<EmailAttachment[]> {
  const results = await Promise.allSettled(
    metas.map(async (m) => {
      const res = await fetch(m.url);
      const buf = Buffer.from(await res.arrayBuffer());
      return { filename: m.name, mimeType: m.contentType, content: buf } satisfies EmailAttachment;
    })
  );
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

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

  // One entry per document: a standalone request, or the first signer of a
  // multi-signer group (the other signers are attached to it below).
  const text = search ? { contains: search, mode: 'insensitive' as const } : undefined;
  const where: Prisma.SigningRequestWhereInput = {
    AND: [
      { workspaceId },
      { OR: [{ groupId: null }, { signerOrder: 0 }] },
      ...(from || to
        ? [{ createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }]
        : []),
      ...(text
        ? [{
            OR: [
              { title: text },
              { recipientName: text },
              { recipientEmail: text },
              { group: { is: { requests: { some: { OR: [{ recipientName: text }, { recipientEmail: text }] } } } } },
            ],
          }]
        : []),
      ...(status ? [documentStatusWhere(status)] : []),
    ],
  };

  const [leads, total] = await Promise.all([
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
        groupId: true,
        batchId: true,
        sentBy: { select: { name: true, email: true } },
        group: { select: { status: true, totalSigners: true, signedCount: true } },
      },
    }),
    prisma.signingRequest.count({ where }),
  ]);

  const groupIds = leads.flatMap((l) => (l.groupId ? [l.groupId] : []));
  const members = groupIds.length
    ? await prisma.signingRequest.findMany({
        where: { groupId: { in: groupIds } },
        orderBy: { signerOrder: 'asc' },
        select: {
          id: true, groupId: true, recipientName: true, recipientEmail: true, signerRole: true,
          signerOrder: true, status: true, sentAt: true, signedAt: true,
        },
      })
    : [];

  const requests = leads.map(({ group, ...lead }) => {
    if (!lead.groupId || !group) return { ...lead, documentStatus: lead.status, signers: null };
    const signers = members.filter((m) => m.groupId === lead.groupId);
    const signedAt = group.status === 'COMPLETED'
      ? signers.reduce<Date | null>((max, m) => (m.signedAt && (!max || m.signedAt > max) ? m.signedAt : max), null)
      : null;
    return {
      ...lead,
      signedAt,
      documentStatus: groupDocumentStatus(group.status, signers.map((m) => m.status)),
      totalSigners: group.totalSigners,
      signedCount: signers.filter((m) => m.status === 'SIGNED').length,
      signers,
    };
  });

  return NextResponse.json({ requests, total, page });
});

/** Overall state of a multi-signer document, in the same vocabulary as a single request. */
function groupDocumentStatus(groupStatus: string, memberStatuses: string[]): string {
  if (groupStatus === 'VOIDED' || (memberStatuses.length > 0 && memberStatuses.every((s) => s === 'VOIDED'))) return 'VOIDED';
  if (groupStatus === 'COMPLETED') return 'SIGNED';
  if (memberStatuses.includes('EXPIRED')) return 'EXPIRED';
  return 'IN_PROGRESS';
}

/** Status filter applied to whole documents rather than individual signer rows. */
function documentStatusWhere(status: string): Prisma.SigningRequestWhereInput {
  const single = { groupId: null, status: status as Prisma.EnumSigningRequestStatusFilter['equals'] };
  if (status === 'SIGNED') return { OR: [single, { group: { is: { status: 'COMPLETED' } } }] };
  if (status === 'VOIDED') return { OR: [single, { group: { is: { status: 'VOIDED' } } }] };
  if (status === 'IN_PROGRESS') return { group: { is: { status: { in: ['PENDING', 'IN_PROGRESS'] } } } };
  return {
    OR: [
      single,
      { group: { is: { status: { in: ['PENDING', 'IN_PROGRESS'] }, requests: { some: { status: status as Prisma.EnumSigningRequestStatusFilter['equals'] } } } } },
    ],
  };
}

const attachmentSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  contentType: z.string(),
  size: z.number(),
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email(),
  fieldValues: z.record(z.string()).default({}),
  attachments: z.array(attachmentSchema).default([]),
  ccEmails: z.array(z.string().email()).default([]),
  expiresInDays: z.number().int().min(1).max(365).default(7),
  emailSubject: z.string().max(300).optional(),
  emailBody: z.string().optional(),
  signaturePlacements: signaturePlacementsSchema.default([]),
});

/** Replace {{student_name}}, {{document_name}}, {{signing_link}}, {{admin_name}} in a template. */
function resolveEmailVars(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{student_name\}\}/g, vars.student_name ?? '')
    .replace(/\{\{document_name\}\}/g, vars.document_name ?? '')
    .replace(/\{\{signing_link\}\}/g, vars.signing_link ?? '')
    .replace(/\{\{admin_name\}\}/g, vars.admin_name ?? '');
}

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
      fieldValues: {
        ...body.fieldValues,
        // A single request has one signer: keep only their boxes.
        ...(body.signaturePlacements.some((p) => p.signerIndex === 1)
          ? { __signaturePlacements: body.signaturePlacements.filter((p) => p.signerIndex === 1) }
          : {}),
      },
      attachments: body.attachments,
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

    const emailVars = {
      student_name: body.recipientName,
      document_name: body.title,
      signing_link: signingUrl,
      admin_name: session.name,
    };

    const subject = body.emailSubject
      ? resolveEmailVars(body.emailSubject, emailVars)
      : `[Action Required] Please sign: ${body.title}`;

    const introHtml = body.emailBody
      ? `<p style="font-size:16px;margin-top:0;">Hi ${body.recipientName},</p>${resolveEmailVars(body.emailBody, emailVars)}`
      : `<p style="font-size:16px;margin-top:0;">Hi ${body.recipientName},</p>
         <p style="font-size:15px;">You've received a document that requires your signature.</p>`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#1a56db;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">MailFlow · Masai School</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    ${introHtml}
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
      const extraAttachments = body.attachments.length
        ? await fetchEmailAttachments(body.attachments)
        : [];
      await new GmailProvider(account).sendEmail({
        to: body.recipientEmail,
        cc: body.ccEmails.length > 0 ? body.ccEmails : undefined,
        fromName: account.displayName || session.name,
        fromEmail: account.emailAddress,
        subject,
        html,
        attachments: extraAttachments.length > 0 ? extraAttachments : undefined,
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
