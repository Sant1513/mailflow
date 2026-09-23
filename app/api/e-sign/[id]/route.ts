import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { GmailProvider } from '@/lib/email/gmail';
import type { AppSession } from '@/lib/auth/session';
import type { Prisma, SigningRequest } from '@prisma/client';
import {
  escapeHtml,
  extractSigningVariables,
  lockedFieldsOf,
  lockedKeysForSigner,
  publicSigningFieldValues,
} from '@/lib/signing/fields';

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

  const groupMembers = request.groupId
    ? await prisma.signingRequest.findMany({
        where: { groupId: request.groupId, status: { not: 'VOIDED' } },
        orderBy: { signerOrder: 'asc' },
        select: { id: true, recipientName: true, recipientEmail: true, signerRole: true, signerOrder: true, status: true, assignedFields: true },
      })
    : [];
  const lockReason = editLockReason(request.status, groupMembers.some((m) => m.status === 'SIGNED'));

  // The signed PDF and signature image are large; the dashboard never needs them here.
  const { signedPdfData: _pdf, signatureImage: _sig, ...rest } = request;
  return NextResponse.json({
    request: {
      ...rest,
      fieldValues: publicSigningFieldValues(request.fieldValues as Record<string, unknown>),
      lockedFields: lockedFieldsOf(request.fieldValues),
      fieldKeys: fieldKeysFor(request.content, request.fieldValues),
      hasSignedPdf: !!_pdf,
    },
    groupMembers,
    editable: lockReason === null,
    lockReason,
  });
});

function editLockReason(status: string, groupHasSignature: boolean): string | null {
  if (status === 'SIGNED') return 'This document has been signed and can no longer be changed.';
  if (status === 'VOIDED') return 'This request was voided.';
  if (status === 'EXPIRED') return 'This request has expired. Use Re-request to send a fresh copy.';
  if (groupHasSignature) return 'Another signer has already signed this document, so it can no longer be changed.';
  return null;
}

function fieldKeysFor(content: string, values: unknown): string[] {
  const keys = new Set(extractSigningVariables(content));
  for (const k of Object.keys(publicSigningFieldValues(values as Record<string, unknown>))) keys.add(k);
  return [...keys].sort();
}

const patchSchema = z.object({
  action: z.enum(['void', 'resend', 'restart', 'update']),
  fieldValues: z.record(z.string().max(5000)).optional(),
  recipientName: z.string().trim().min(1).max(200).optional(),
  recipientEmail: z.string().trim().toLowerCase().email().optional(),
  notify: z.boolean().optional().default(true),
});

/** PATCH /api/e-sign/[id] — void, resend, or restart a signing request. */
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

  if (body.action === 'update') {
    return updateRequest(session, existing, body);
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

  if (body.action === 'restart') {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const newRequest = await prisma.signingRequest.create({
      data: {
        workspaceId,
        title: existing.title,
        content: existing.content,
        recipientName: existing.recipientName,
        recipientEmail: existing.recipientEmail,
        fieldValues: existing.fieldValues ?? {},
        ccEmails: existing.ccEmails,
        status: 'SENT',
        sentAt: now,
        expiresAt,
        sentById: session.userId,
      },
    });

    const account = await prisma.emailProviderAccount.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });

    if (account) {
      const signingUrl = `${process.env.NEXTAUTH_URL}/sign/${newRequest.token}`;
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
    <p style="font-size:16px;margin-top:0;">Hi ${existing.recipientName},</p>
    <p style="font-size:15px;">A new signing request has been issued for the document below.</p>
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
          subject: `[Action Required] Please sign: ${existing.title}`,
          html,
        });
      } catch (err) {
        console.error('[e-sign] failed to send restart invitation email', err);
      }
    }

    await audit(session, 'SIGNING_REQUEST_RESTARTED', {
      targetType: 'SigningRequest',
      targetId: existing.id,
      metadata: { newRequestId: newRequest.id },
    });

    return NextResponse.json({ request: newRequest }, { status: 201 });
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

const EDITABLE_STATUSES = ['DRAFT', 'SENT', 'VIEWED'] as const;

class EditConflict extends Error {}

/**
 * Edits the sender-provided details of a request that nobody has signed yet.
 * For multi-signer documents the whole group is updated so every signer sees
 * the same values; locks are recomputed so blank fields stay signer-fillable.
 */
async function updateRequest(
  session: AppSession,
  existing: SigningRequest,
  body: z.infer<typeof patchSchema>,
) {
  const allowedKeys = fieldKeysFor(existing.content, existing.fieldValues);
  const incoming = Object.fromEntries(
    Object.entries(body.fieldValues ?? {}).map(([k, v]) => [k, v.trim()]),
  );
  const unknownKey = Object.keys(incoming).find((k) => !allowedKeys.includes(k));
  if (unknownKey) {
    return NextResponse.json({ error: `Unknown field "${unknownKey}".` }, { status: 400 });
  }

  let outcome: { targets: SigningRequest[]; changedKeys: string[]; newEmail: string | null } | { error: string };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const targets = existing.groupId
        ? await tx.signingRequest.findMany({
            where: { groupId: existing.groupId, status: { not: 'VOIDED' } },
            orderBy: { signerOrder: 'asc' },
          })
        : await tx.signingRequest.findMany({ where: { id: existing.id } });
      const me = targets.find((t) => t.id === existing.id);
      const reason = editLockReason(me?.status ?? existing.status, targets.some((t) => t.status === 'SIGNED'));
      if (!me || reason) return { error: reason ?? 'This request can no longer be changed.' };

      const baseValues = publicSigningFieldValues(me.fieldValues as Record<string, unknown>);
      const newValues = { ...baseValues, ...incoming };
      const changedKeys = allowedKeys.filter((k) => (baseValues[k] ?? '') !== (newValues[k] ?? ''));

      const isMulti = targets.length > 1;
      const assignments = targets.map((t) => [...(t.assignedFields ?? [])]);
      if (isMulti) {
        const claimed = new Set(assignments.flat());
        const orphanBlanks = allowedKeys.filter((k) => !(newValues[k] ?? '').trim() && !claimed.has(k));
        assignments[0] = [...new Set([...(assignments[0] ?? []), ...orphanBlanks])];
      }

      const newEmail = body.recipientEmail && body.recipientEmail !== me.recipientEmail ? body.recipientEmail : null;

      for (const [i, t] of targets.entries()) {
        const raw = (t.fieldValues ?? {}) as Record<string, unknown>;
        const internal = Object.fromEntries(
          Object.entries(raw).filter(([k]) => k.startsWith('__') && k !== '__lockedFields'),
        );
        const assigned = assignments[i] ?? [];
        const data: Prisma.SigningRequestUpdateManyMutationInput = {
          fieldValues: {
            ...newValues,
            ...internal,
            __lockedFields: lockedKeysForSigner(allowedKeys, newValues, assigned, isMulti),
          },
          assignedFields: assigned,
        };
        if (t.id === me.id) {
          if (body.recipientName) data.recipientName = body.recipientName;
          if (newEmail) data.recipientEmail = newEmail;
        }
        // Guarded write: if a signer submitted in the meantime, abort everything.
        const res = await tx.signingRequest.updateMany({
          where: { id: t.id, status: { in: [...EDITABLE_STATUSES] } },
          data,
        });
        if (res.count !== 1) throw new EditConflict();
      }

      const refreshed = await tx.signingRequest.findMany({
        where: { id: { in: targets.map((t) => t.id) } },
        orderBy: { signerOrder: 'asc' },
      });
      return { targets: refreshed, changedKeys, newEmail };
    });
  } catch (err) {
    if (err instanceof EditConflict) {
      return NextResponse.json({ error: 'A signer just signed this document, so it can no longer be changed.' }, { status: 409 });
    }
    throw err;
  }

  if ('error' in outcome) {
    return NextResponse.json({ error: outcome.error }, { status: 409 });
  }

  let notified = 0;
  if (body.notify) {
    const active = outcome.targets.filter((t) => t.status === 'SENT' || t.status === 'VIEWED');
    const account = active.length
      ? await prisma.emailProviderAccount.findFirst({
          where: { workspaceId: existing.workspaceId },
          orderBy: { createdAt: 'asc' },
        })
      : null;
    if (account) {
      const results = await Promise.allSettled(
        active.map((t) =>
          new GmailProvider(account).sendEmail({
            to: t.recipientEmail,
            cc: t.ccEmails.length > 0 ? t.ccEmails : undefined,
            fromName: account.displayName || session.name,
            fromEmail: account.emailAddress,
            subject: `[Updated] Please review and sign: ${t.title}`,
            html: buildUpdatedHtml({
              recipientName: t.recipientName,
              title: t.title,
              signingUrl: `${process.env.NEXTAUTH_URL}/sign/${t.token}`,
              senderName: session.name,
              expiresAt: t.expiresAt,
            }),
          }),
        ),
      );
      notified = results.filter((r) => r.status === 'fulfilled').length;
    }
  }

  await audit(session, 'SIGNING_REQUEST_UPDATED', {
    targetType: 'SigningRequest',
    targetId: existing.id,
    metadata: {
      changedKeys: outcome.changedKeys,
      groupId: existing.groupId,
      recipientEmailChanged: !!outcome.newEmail,
      notified,
    },
  });

  return NextResponse.json({ updated: true, changedKeys: outcome.changedKeys, notified });
}

function buildUpdatedHtml(opts: {
  recipientName: string;
  title: string;
  signingUrl: string;
  senderName: string;
  expiresAt: Date | null;
}): string {
  const expires = opts.expiresAt
    ? opts.expiresAt.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#1a56db;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">MailFlow · Masai School</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:32px 24px;border-radius:0 0 8px 8px;">
    <p style="font-size:16px;margin-top:0;">Hi ${escapeHtml(opts.recipientName)},</p>
    <p style="font-size:15px;">The sender has updated the details of the document below. Please review the latest version before signing.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Document</p>
      <p style="margin:6px 0 0;font-size:18px;font-weight:600;color:#111;">${escapeHtml(opts.title)}</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${opts.signingUrl}"
         style="background:#1a56db;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
        Review &amp; Sign Document
      </a>
    </div>
    ${expires ? `<p style="font-size:13px;color:#6b7280;margin-bottom:4px;">This link expires on <strong>${expires}</strong>.</p>` : ''}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
    <p style="font-size:12px;color:#9ca3af;margin:0;">Sent by ${escapeHtml(opts.senderName)} &middot; placements@masaischool.com</p>
  </div>
</body>
</html>`;
}
