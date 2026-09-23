import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { withErrorHandling } from '@/lib/api/respond';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';
import type { EmailAttachment } from '@/lib/email/provider';
import { generateSignedPdf } from '@/lib/documents/pdf';
import { publicSigningFieldValues, mergeGroupFieldValues } from '@/lib/signing/fields';

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

  // Block access if this signer's turn hasn't come yet (sequential multi-signer)
  if (request.status === 'DRAFT') {
    return NextResponse.json({ error: 'waiting', message: 'Waiting for previous signer(s) to complete.' }, { status: 423 });
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

  // For multi-signer groups, gather previous signers' info
  let previousSignatures: { signerName: string; signerRole: string; signedAt: string }[] = [];
  let groupProgress: { current: number; total: number } | null = null;

  if (request.groupId) {
    const group = await prisma.signingGroup.findUnique({
      where: { id: request.groupId },
    });
    if (group) {
      groupProgress = { current: request.signerOrder + 1, total: group.totalSigners };
    }
    const prevSigners = await prisma.signingRequest.findMany({
      where: {
        groupId: request.groupId,
        status: 'SIGNED',
        signerOrder: { lt: request.signerOrder },
      },
      orderBy: { signerOrder: 'asc' },
      select: { recipientName: true, signerRole: true, signedAt: true },
    });
    previousSignatures = prevSigners.map((s) => ({
      signerName: s.recipientName,
      signerRole: s.signerRole ?? '',
      signedAt: s.signedAt?.toISOString() ?? '',
    }));
  }

  return NextResponse.json({
    id: request.id,
    title: request.title,
    content: request.content,
    recipientName: request.recipientName,
    fieldValues: publicSigningFieldValues(request.fieldValues as Record<string, unknown>),
    lockedFields: lockedFieldsOf(request.fieldValues),
    assignedFields: request.assignedFields ?? [],
    signerRole: request.signerRole,
    groupProgress,
    previousSignatures,
    status: request.status === 'SENT' ? 'VIEWED' : request.status,
    expiresAt: request.expiresAt,
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
  const lockedFields = lockedFieldsOf(request.fieldValues);
  const attemptedLockedEdit = Object.keys(body.fieldValues ?? {}).find((key) => lockedFields.includes(key));
  if (attemptedLockedEdit) {
    return NextResponse.json(
      { error: `Field "${attemptedLockedEdit}" is locked and cannot be changed by the signer.` },
      { status: 403 }
    );
  }

  // Enforce per-signer field assignment: if assignedFields is set, signer can only fill those
  const assigned = request.assignedFields ?? [];
  if (assigned.length > 0 && body.fieldValues) {
    const disallowed = Object.keys(body.fieldValues).find(
      (key) => !assigned.includes(key) && !lockedFields.includes(key),
    );
    if (disallowed) {
      return NextResponse.json(
        { error: `Field "${disallowed}" is not assigned to this signer.` },
        { status: 403 }
      );
    }
  }

  // Merge admin pre-fills with signer-submitted values, but locked CSV/template
  // variables remain server-owned and cannot be overwritten by the public link.
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
  if (request.batchId) {
    const signedCount = await prisma.signingRequest.count({
      where: { batchId: request.batchId, status: 'SIGNED' },
    });
    await prisma.signingBatch.update({
      where: { id: request.batchId },
      data: { signedCount },
    });
  }

  // ── Multi-signer group advancement ──
  let nextSignerRequest: typeof request | null = null;
  let groupAdvancedNextId: string | null = null;
  let completedGroupId: string | null = null;
  let groupCompletionSigners: { name: string; email: string }[] = [];
  let combinedPdfBuffer: Buffer | null = null;

  if (request.groupId) {
    const group = await prisma.signingGroup.findUnique({
      where: { id: request.groupId },
    });

    if (group) {
      const newSignedCount = group.signedCount + 1;
      const allDone = newSignedCount >= group.totalSigners;

      await prisma.signingGroup.update({
        where: { id: group.id },
        data: {
          signedCount: newSignedCount,
          status: allDone ? 'COMPLETED' : 'IN_PROGRESS',
        },
      });

      if (!allDone && group.signingOrder === 'SEQUENTIAL') {
        // Activate the next signer in order
        nextSignerRequest = await prisma.signingRequest.findFirst({
          where: {
            groupId: group.id,
            status: 'DRAFT',
            signerOrder: request.signerOrder + 1,
          },
        });

        if (nextSignerRequest) {
          // Propagate the current merged field values to the next signer so they see previous signers' work
          const nextFieldValues = {
            ...((nextSignerRequest.fieldValues as Record<string, string>) ?? {}),
          };
          const publicMerged = publicSigningFieldValues(mergedFieldValues);
          for (const [k, v] of Object.entries(publicMerged)) {
            nextFieldValues[k] = v;
          }

          // Extend expiry for next signer using the same window as the current signer
          const windowMs = request.expiresAt && request.sentAt
            ? request.expiresAt.getTime() - request.sentAt.getTime()
            : 7 * 24 * 60 * 60 * 1000;

          await prisma.signingRequest.update({
            where: { id: nextSignerRequest.id },
            data: {
              status: 'SENT',
              sentAt: now,
              expiresAt: new Date(now.getTime() + windowMs),
              fieldValues: nextFieldValues,
            },
          });
          groupAdvancedNextId = nextSignerRequest.id;
        }
      }

      // When all signers are done, store combined PDF on the group
      if (allDone) {
        const allGroupRequests = await prisma.signingRequest.findMany({
          where: { groupId: group.id, status: 'SIGNED' },
          orderBy: { signerOrder: 'asc' },
        });

        // Merge ALL signers' field values: locked/CSV fields from first, then each signer's assigned values
        let combinedValues: Record<string, string> =
          (allGroupRequests[0]?.fieldValues as Record<string, string>) ?? mergedFieldValues;
        for (const r of allGroupRequests.slice(1)) {
          const rAssigned = (r.assignedFields ?? []) as string[];
          const rPublic = publicSigningFieldValues((r.fieldValues ?? {}) as Record<string, unknown>);
          combinedValues = mergeGroupFieldValues(combinedValues, rPublic, rAssigned);
        }

        const combinedPdf = await generateSignedPdf({
          title: request.title,
          content: request.content,
          recipientName: allGroupRequests.map((r) => r.recipientName).join(', '),
          recipientEmail: allGroupRequests.map((r) => r.recipientEmail).join(', '),
          fieldValues: combinedValues,
          signatureImage: body.signatureImage,
          signedAt: now,
          signerIp,
          additionalSignatures: allGroupRequests.map((r) => ({
            signerName: r.recipientName,
            signerEmail: r.recipientEmail,
            signerRole: r.signerRole ?? `Signer ${r.signerOrder + 1}`,
            signatureImage: r.signatureImage ?? '',
            signedAt: r.signedAt ?? now,
            signerIp: r.signerIp ?? 'unknown',
            signerOrder: r.signerOrder,
          })),
        });

        await prisma.signingGroup.update({
          where: { id: group.id },
          data: { combinedPdfData: combinedPdf.toString('base64') },
        });

        completedGroupId = group.id;
        combinedPdfBuffer = combinedPdf;
        groupCompletionSigners = allGroupRequests.map((r) => ({
          name: r.recipientName,
          email: r.recipientEmail,
        }));
      }
    }
  }

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
      const storedAttachments = Array.isArray(request.attachments)
        ? (request.attachments as unknown as AttachmentMeta[])
        : [];
      const extraAttachments = storedAttachments.length
        ? await fetchEmailAttachments(storedAttachments)
        : [];
      const allAttachments = [pdfAttachment, ...extraAttachments];

      await Promise.allSettled([
        new GmailProvider(account).sendEmail({
          to: request.recipientEmail,
          fromName: account.displayName || 'MailFlow',
          fromEmail: account.emailAddress,
          subject: `Document Signed: ${request.title}`,
          html: recipientHtml,
          attachments: allAttachments,
        }),
        new GmailProvider(account).sendEmail({
          to: notifyTo,
          cc: remainingCc.length > 0 ? remainingCc : undefined,
          fromName: account.displayName || 'MailFlow',
          fromEmail: account.emailAddress,
          subject: `[Signed] ${request.recipientName} has signed: ${request.title}`,
          html: teamHtml,
          attachments: allAttachments,
        }),
      ]);
    } catch (err) {
      console.error('[sign] failed to send confirmation emails', err);
    }

    // When all signers complete a group, send the combined PDF to every signer
    if (combinedPdfBuffer && groupCompletionSigners.length > 0) {
      try {
        const combinedFilename = `${request.title.replace(/\s+/g, '_')}_signed_complete.pdf`;
        const combinedAttachment = {
          filename: combinedFilename,
          mimeType: 'application/pdf',
          content: combinedPdfBuffer,
        };
        const completionHtml = buildGroupCompletionHtml({
          title: request.title,
          signers: groupCompletionSigners,
        });
        await Promise.allSettled(
          groupCompletionSigners.map((s) =>
            new GmailProvider(account).sendEmail({
              to: s.email,
              fromName: account.displayName || 'MailFlow',
              fromEmail: account.emailAddress,
              subject: `[Completed] All signatures collected: ${request.title}`,
              html: completionHtml,
              attachments: [combinedAttachment],
            })
          )
        );
      } catch (err) {
        console.error('[sign] failed to send group completion emails', err);
      }
    }

    // Send invitation to the next signer in the group (sequential advancement)
    if (nextSignerRequest) {
      try {
        const signingUrl = `${process.env.NEXTAUTH_URL}/sign/${nextSignerRequest.token}`;
        const nextValues = nextSignerRequest.fieldValues as Record<string, string>;
        const expiresDateStr = nextSignerRequest.expiresAt
          ? nextSignerRequest.expiresAt.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })
          : '';
        const nextInviteHtml = buildNextSignerHtml({
          recipientName: nextSignerRequest.recipientName,
          title: nextSignerRequest.title,
          signingUrl,
          expiresDateStr,
          signerRole: nextValues.__signerRole ?? nextSignerRequest.signerRole ?? '',
          previousSigner: request.recipientName,
        });
        await new GmailProvider(account).sendEmail({
          to: nextSignerRequest.recipientEmail,
          cc: nextSignerRequest.ccEmails.length > 0 ? nextSignerRequest.ccEmails : undefined,
          fromName: account.displayName || 'MailFlow',
          fromEmail: account.emailAddress,
          subject: `[Action Required] Your turn to sign: ${nextSignerRequest.title}`,
          html: nextInviteHtml,
        });
      } catch (err) {
        console.error('[sign] failed to send next-signer invitation', err);
      }
    }
  }

  // Audit log — resolve organizationId from the workspace
  const workspace = await prisma.workspace.findUnique({
    where: { id: request.workspaceId },
    select: { organizationId: true },
  });

  if (workspace) {
    const orgCtx = { organizationId: workspace.organizationId };

    if (groupAdvancedNextId) {
      await audit(orgCtx, 'SIGNING_GROUP_ADVANCED', {
        targetType: 'SigningGroup',
        targetId: request.groupId!,
        metadata: { nextRequestId: groupAdvancedNextId, completedBy: request.id, signerOrder: request.signerOrder },
      });
    }
    if (completedGroupId) {
      await audit(orgCtx, 'SIGNING_GROUP_COMPLETED', {
        targetType: 'SigningGroup',
        targetId: completedGroupId,
        metadata: { batchId: request.batchId, completedBy: request.id },
      });
    }

    await audit(orgCtx, 'SIGNING_REQUEST_SIGNED', {
      targetType: 'SigningRequest',
      targetId: request.id,
      metadata: { signerIp, signerAgent, signedAt: now.toISOString() },
    });
  }

  return NextResponse.json({ signed: true });
});

function lockedFieldsOf(values: unknown): string[] {
  if (!values || typeof values !== 'object') return [];
  const raw = (values as Record<string, unknown>).__lockedFields;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function buildGroupCompletionHtml({
  title,
  signers,
}: {
  title: string;
  signers: { name: string; email: string }[];
}): string {
  const signerList = signers
    .map((s) => `<li style="margin-bottom:4px;">${s.name} &lt;${s.email}&gt;</li>`)
    .join('');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#059669;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">All Signatures Collected</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    <p style="font-size:15px;margin-top:0;">
      All parties have signed <strong>${title}</strong>. The fully executed document is attached to this email.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Signatories</p>
      <ul style="margin:0;padding-left:18px;font-size:14px;">${signerList}</ul>
    </div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="font-size:12px;color:#9ca3af;margin:0;">MailFlow · placements@masaischool.com</p>
  </div>
</body>
</html>`;
}

function buildNextSignerHtml({
  recipientName,
  title,
  signingUrl,
  expiresDateStr,
  signerRole,
  previousSigner,
}: {
  recipientName: string;
  title: string;
  signingUrl: string;
  expiresDateStr: string;
  signerRole: string;
  previousSigner: string;
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
    <p style="font-size:15px;">
      <strong>${previousSigner}</strong> has completed their signature. It's now your turn to review and sign this document${signerRole ? ` as <strong>${signerRole}</strong>` : ''}.
    </p>
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
    ${expiresDateStr ? `<p style="font-size:13px;color:#6b7280;margin-bottom:4px;">This link expires on <strong>${expiresDateStr}</strong>.</p>` : ''}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="font-size:12px;color:#9ca3af;margin:0;">placements@masaischool.com</p>
  </div>
</body>
</html>`;
}
