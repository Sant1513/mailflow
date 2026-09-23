import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';
import type { EmailAttachment } from '@/lib/email/provider';
import { mergeSigningFieldDefs, normalizeBulkSigners, publicSigningFieldValues, type BulkSignerConfig } from '@/lib/signing/fields';

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
  signers: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    role: z.string().min(1).max(100),
  })).max(3).optional(),
});

const attachmentSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  contentType: z.string(),
  size: z.number(),
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  templateId: z.string().optional(),
  recipients: z.array(recipientSchema).min(1).max(200),
  signers: z.array(z.object({
    index: z.number().int().min(1).max(3),
    role: z.string().min(1).max(100),
    nameColumn: z.string().min(1),
    emailColumn: z.string().min(1),
    assignedFields: z.array(z.string()).default([]),
  })).max(3).optional(),
  signingOrder: z.enum(['SEQUENTIAL', 'PARALLEL']).default('SEQUENTIAL'),
  attachments: z.array(attachmentSchema).default([]),
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
  let templateFields: { key: string; label: string; defaultValue?: string }[] = [];
  if (body.templateId) {
    const tpl = await prisma.signingTemplate.findFirst({
      where: { id: body.templateId, workspaceId },
    });
    if (!tpl) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 });
    }
    templateContent = tpl.content;
    templateFields = mergeSigningFieldDefs(tpl.content, Array.isArray(tpl.fieldDefs) ? tpl.fieldDefs as { key: string; label: string; defaultValue?: string }[] : []);
  }
  const fieldKeys = templateFields.map((f) => f.key);
  const signers = normalizeBulkSigners((body.signers ?? []) as BulkSignerConfig[]);
  const isMultiSigner = signers.length > 1;
  const signingOrder = body.signingOrder;

  // Build a lookup of signer index → assigned field keys
  const signerFieldMap = new Map<number, string[]>();
  for (const s of (body.signers ?? [])) {
    if (s.assignedFields?.length) signerFieldMap.set(s.index, s.assignedFields);
  }

  const missing: string[] = [];
  const expandedRecipients = body.recipients.flatMap((r, rowIndex) => {
    for (const key of fieldKeys) {
      const value = r.fieldValues[key] ?? templateFields.find((f) => f.key === key)?.defaultValue ?? '';
      if (!value.trim()) missing.push(`Row ${rowIndex + 1}: missing ${key}`);
    }
    const rowSigners = r.signers?.length
      ? r.signers
      : [{ name: r.name, email: r.email, role: signers[0]?.role ?? 'Signer 1' }];
    return rowSigners.map((s, signerIndex) => ({
      rowIndex,
      signerIndex: signerIndex + 1,
      name: s.name,
      email: s.email,
      role: s.role,
      fieldValues: r.fieldValues,
      assignedFields: signerFieldMap.get(signerIndex + 1) ?? [],
    }));
  });
  if (missing.length) {
    return NextResponse.json({ error: 'CSV/document variables are incomplete.', issues: missing.slice(0, 50) }, { status: 400 });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000);

  // Create the batch record
  const batch = await prisma.signingBatch.create({
    data: {
      workspaceId,
      templateId: body.templateId ?? null,
      title: body.title,
      totalCount: expandedRecipients.length,
      createdById: session.userId,
    },
  });

  // For multi-signer rows, create a SigningGroup per CSV row
  const rowGroupMap = new Map<number, string>();
  if (isMultiSigner) {
    const uniqueRows = [...new Set(expandedRecipients.map((r) => r.rowIndex))];
    const groups = await Promise.all(
      uniqueRows.map((rowIndex) =>
        prisma.signingGroup.create({
          data: {
            workspaceId,
            batchId: batch.id,
            signingOrder,
            totalSigners: signers.length,
          },
        }),
      ),
    );
    uniqueRows.forEach((rowIndex, i) => {
      rowGroupMap.set(rowIndex, groups[i]!.id);
    });
  }

  // Create a SigningRequest for each recipient
  const requests = await Promise.all(
    expandedRecipients.map((r) => {
      const publicValues = publicSigningFieldValues(r.fieldValues);
      for (const field of templateFields) {
        if (publicValues[field.key] === undefined && field.defaultValue) publicValues[field.key] = field.defaultValue;
      }
      const groupId = rowGroupMap.get(r.rowIndex) ?? null;
      const isFirstSigner = r.signerIndex === 1;
      const shouldSendNow = !isMultiSigner || isFirstSigner || signingOrder === 'PARALLEL';
      return prisma.signingRequest.create({
        data: {
          workspaceId,
          batchId: batch.id,
          groupId,
          signerOrder: r.signerIndex - 1,
          signerRole: r.role,
          assignedFields: r.assignedFields,
          title: body.title,
          content: templateContent ?? '<p>Please sign this document.</p>',
          recipientName: r.name,
          recipientEmail: r.email,
          fieldValues: {
            ...publicValues,
            __lockedFields: fieldKeys,
            __bulkRow: String(r.rowIndex + 1),
            __signerIndex: String(r.signerIndex),
            __signerRole: r.role,
          },
          attachments: body.attachments,
          ccEmails: body.ccEmails,
          status: shouldSendNow ? 'SENT' : 'DRAFT',
          sentAt: shouldSendNow ? now : null,
          expiresAt,
          sentById: session.userId,
        },
      });
    }),
  );

  // Get the workspace email account for sending
  const account = await prisma.emailProviderAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  let sentCount = 0;
  const requestsToEmail = requests.filter((r) => r.status === 'SENT');

  if (account && requestsToEmail.length > 0) {
    const expiresDateStr = expiresAt.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // Fetch extra attachments once — shared across all recipients
    const extraAttachments = body.attachments.length
      ? await fetchEmailAttachments(body.attachments)
      : [];

    // Send invitation emails only to active signers (first signer in sequential mode)
    const results = await Promise.allSettled(
      requestsToEmail.map((sigReq) => {
        const signingUrl = `${process.env.NEXTAUTH_URL}/sign/${sigReq.token}`;
        const values = sigReq.fieldValues as Record<string, string>;
        const html = buildInviteHtml({
          recipientName: sigReq.recipientName,
          title: body.title,
          signingUrl,
          expiresDateStr,
          senderName: session.name,
          signerRole: values.__signerRole,
        });
        return new GmailProvider(account).sendEmail({
          to: sigReq.recipientEmail,
          cc: body.ccEmails.length > 0 ? body.ccEmails : undefined,
          fromName: account.displayName || session.name,
          fromEmail: account.emailAddress,
          subject: `[Action Required] Please sign: ${body.title}`,
          html,
          attachments: extraAttachments.length > 0 ? extraAttachments : undefined,
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
    metadata: { batchId: batch.id, totalCount: expandedRecipients.length, csvRows: body.recipients.length, signerCount: signers.length, signingOrder },
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
  signerRole,
}: {
  recipientName: string;
  title: string;
  signingUrl: string;
  expiresDateStr: string;
  senderName: string;
  signerRole?: string;
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
    <p style="font-size:15px;">You've received a document that requires your signature${signerRole ? ` as <strong>${signerRole}</strong>` : ''}.</p>
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
