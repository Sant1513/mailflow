import { google } from 'googleapis';
import type { EmailProviderAccount } from '@prisma/client';
import { authorizedClientFor } from '@/lib/gmail/oauth';
import { buildMimeMessage } from '@/lib/email/mime';
import { SendEmailError, type SendEmailInput } from '@/lib/email/provider';

/**
 * Sends a large recruiter email (e.g. with a video attached) through Gmail's upload endpoint,
 * which takes messages up to 35 MB. Campaign sending is unchanged; this is only used by
 * lib/recruiterSend/worker.ts when a message is too big for a normal request.
 */
export const UPLOAD_THRESHOLD_BYTES = 3 * 1024 * 1024;

function classify(err: unknown): SendEmailError {
  const e = err as { code?: number | string; message?: string; response?: { status?: number; data?: unknown } };
  const status = Number(e.response?.status ?? e.code ?? 0);
  const message = String(e.message ?? 'Gmail error');
  if (/invalid_grant|unauthorized|invalid credentials/i.test(message) || status === 401) return new SendEmailError(message, 'AUTH', String(status));
  if (/quota|daily limit|limit exceeded for sending/i.test(message)) return new SendEmailError(message, 'QUOTA', String(status));
  if (status === 429 || /rate ?limit|too many/i.test(message)) return new SendEmailError(message, 'RATE_LIMIT', String(status));
  if (status === 400 && /recipient|address/i.test(message)) return new SendEmailError(message, 'INVALID_RECIPIENT', String(status));
  return new SendEmailError(message, 'TRANSIENT', String(status));
}

export async function sendViaUpload(account: EmailProviderAccount, input: SendEmailInput): Promise<{ providerMessageId: string }> {
  if (input.fromEmail.toLowerCase() !== account.emailAddress.toLowerCase()) {
    throw new SendEmailError(`From (${input.fromEmail}) does not match the mailbox (${account.emailAddress}).`, 'AUTH');
  }
  const { raw } = buildMimeMessage({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    replyTo: input.replyTo,
    subject: input.subject,
    html: input.html,
    plainText: input.plainText,
    attachments: input.attachments,
    listUnsubscribeUrl: input.listUnsubscribeUrl,
  });
  try {
    const gmail = google.gmail({ version: 'v1', auth: await authorizedClientFor(account) });
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: {}, media: { mimeType: 'message/rfc822', body: raw } });
    if (!res.data.id) throw new SendEmailError('Gmail accepted the message but returned no id.', 'UNKNOWN');
    return { providerMessageId: res.data.id };
  } catch (err) {
    if (err instanceof SendEmailError) throw err;
    throw classify(err);
  }
}
