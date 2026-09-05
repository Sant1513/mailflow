import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { requireSession, ForbiddenError } from '@/lib/auth/session';
import { withErrorHandling } from '@/lib/api/respond';
import { requireCanWrite } from '@/lib/permissions/workspace';
import { audit } from '@/lib/audit/log';
import { loadTemplateForSession, latestVersionOf } from '@/lib/templates/access';
import { renderTemplate } from '@/lib/templates/variables';
import { GmailProvider } from '@/lib/email/gmail';
import { SendEmailError } from '@/lib/email/provider';
import { EmailProvider as EmailProviderEnum, Role } from '@prisma/client';

const testSchema = z.object({
  to: z.string().email(),
  recordId: z.string().optional(),
  draft: z
    .object({
      subject: z.string(),
      html: z.string(),
      css: z.string().nullable().optional(),
      plainText: z.string().nullable().optional(),
    })
    .optional(),
});

/**
 * §26 Send Test Email — exactly ONE message, to an address the user types,
 * using a sample record for personalization. Campaign recipients are never
 * involved: this route reads records only to resolve variables, and sends to
 * `to` and nothing else.
 */
export const POST = withErrorHandling(async (req, { params }: { params: { id: string } }) => {
  const session = await requireSession();
  requireCanWrite(session);
  const template = await loadTemplateForSession(session, params.id);
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = testSchema.parse(await req.json());

  const source = body.draft ?? latestVersionOf(template.versions);
  if (!source) return NextResponse.json({ error: 'Template has no content yet' }, { status: 400 });

  if (!session.workspaceId) throw new ForbiddenError('No workspace on session');
  const account = await prisma.emailProviderAccount.findUnique({
    where: {
      workspaceId_userId_provider: {
        workspaceId: session.workspaceId,
        userId: session.userId,
        provider: EmailProviderEnum.GMAIL,
      },
    },
  });
  if (!account || account.status !== 'CONNECTED') {
    return NextResponse.json(
      { error: 'Connect your Gmail account in Settings before sending a test email.' },
      { status: 400 }
    );
  }

  let data: Record<string, unknown> = {};
  if (body.recordId) {
    const record = await prisma.record.findUnique({ where: { id: body.recordId }, include: { dataset: true } });
    if (!record) return NextResponse.json({ error: 'Sample record not found' }, { status: 404 });
    if (record.dataset.workspaceId !== session.workspaceId && session.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenError();
    }
    data = record.data as Record<string, unknown>;
  }

  const rendered = renderTemplate(
    { subject: source.subject, html: source.html, plainText: source.plainText },
    data
  );
  const html = source.css ? `<style>${source.css}</style>${rendered.html}` : rendered.html;

  // Clearly marked so a test can never be mistaken for the real thing (§26).
  const subject = `[TEST] ${rendered.subject}`;
  const banner =
    '<div style="background:#fff4e5;border:1px solid #ffcc80;padding:8px 12px;margin-bottom:16px;font:13px sans-serif;color:#7a4f01;">' +
    'TEST EMAIL — sent from MailFlow to verify this template. No campaign recipients received this message.' +
    '</div>';

  try {
    const provider = new GmailProvider(account);
    const result = await provider.sendEmail({
      to: body.to,
      fromName: account.displayName ?? session.name,
      fromEmail: account.emailAddress,
      subject,
      html: banner + html,
      plainText: rendered.plainText ? `[TEST EMAIL]\n\n${rendered.plainText}` : null,
    });

    await audit(session, 'TEMPLATE_TEST_SEND', {
      targetType: 'Template',
      targetId: template.id,
      metadata: { to: body.to, gmailMessageId: result.providerMessageId },
    });

    return NextResponse.json({
      sent: true,
      to: body.to,
      subject,
      gmailMessageId: result.providerMessageId,
      gmailThreadId: result.threadId,
    });
  } catch (err) {
    const sendError = err instanceof SendEmailError ? err : null;
    return NextResponse.json(
      {
        error: sendError?.message ?? 'Failed to send the test email.',
        kind: sendError?.kind,
        hint:
          sendError?.kind === 'AUTH'
            ? 'Your Gmail connection needs to be re-authorized in Settings.'
            : sendError?.kind === 'RATE_LIMIT'
              ? 'Gmail is rate limiting; try again shortly.'
              : undefined,
      },
      { status: 502 }
    );
  }
});
