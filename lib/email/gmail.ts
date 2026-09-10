import { google } from 'googleapis';
import type { EmailProviderAccount } from '@prisma/client';
import { authorizedClientFor, markAccountExpired } from '@/lib/gmail/oauth';
import { buildMimeMessage, toGmailRaw } from './mime';
import {
  SendEmailError,
  type EmailProvider,
  type SendEmailInput,
  type SendEmailResult,
  type SendErrorKind,
} from './provider';

/**
 * §28/§141: sends via the official Gmail API as the authenticated user.
 * Never a shared "noreply@" sender, never scraping, never stored passwords.
 */
export class GmailProvider implements EmailProvider {
  readonly name = 'gmail';

  constructor(private readonly account: EmailProviderAccount) {}

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    // The From address is pinned to the connected account (§28). A caller
    // cannot spoof an arbitrary sender even if it passes one in.
    if (input.fromEmail.toLowerCase() !== this.account.emailAddress.toLowerCase()) {
      throw new SendEmailError(
        `Refusing to send: fromEmail (${input.fromEmail}) does not match the connected Gmail account (${this.account.emailAddress}).`,
        'AUTH'
      );
    }

    const { raw, messageIdHeader } = buildMimeMessage({
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
      inReplyTo: input.inReplyTo,
      references: input.references,
    });

    try {
      const auth = await authorizedClientFor(this.account);
      const gmail = google.gmail({ version: 'v1', auth });

      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: toGmailRaw(raw),
          // Passing threadId keeps the message in an existing Gmail thread
          // (§54 "Continue Conversation"); omitting it starts a new one.
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });

      const data = response.data;
      if (!data.id) {
        throw new SendEmailError('Gmail accepted the request but returned no message id.', 'UNKNOWN');
      }

      // Gmail REPLACES the Message-ID we put in the MIME with one of its
      // own (<...@mail.gmail.com>) on send. A recipient's reply cites
      // Gmail's ID in In-Reply-To, so storing ours would leave threading
      // by Message-ID silently dead and put a phantom ID into every
      // References chain. Read the real header back; it costs one cheap
      // metadata GET per send. Found only by a live round-trip — the fake
      // provider preserved the ID and hid this.
      let finalMessageId = messageIdHeader;
      try {
        const sent = await gmail.users.messages.get({
          userId: 'me',
          id: data.id,
          format: 'metadata',
          metadataHeaders: ['Message-Id'],
        });
        const real = sent.data.payload?.headers?.find((h) => (h.name ?? '').toLowerCase() === 'message-id')?.value;
        if (real) finalMessageId = real.trim();
      } catch (readErr) {
        // The send already succeeded; a failed read-back must not turn it
        // into a failure. Keep our ID and say so.
        console.warn('[gmail] could not read back Message-Id after send; keeping generated id', (readErr as Error).message);
      }

      return {
        providerMessageId: data.id,
        threadId: data.threadId ?? null,
        messageIdHeader: finalMessageId,
        raw: { labelIds: data.labelIds, internalDate: data.internalDate, generatedMessageId: messageIdHeader },
      };
    } catch (err) {
      throw await this.translateError(err);
    }
  }

  /**
   * Maps Google's error shapes onto our retry policy (§42). Getting this
   * wrong either retries a permanently-invalid address forever, or gives up
   * on a transient blip.
   */
  private async translateError(err: unknown): Promise<SendEmailError> {
    if (err instanceof SendEmailError) return err;

    const anyErr = err as {
      code?: number | string;
      status?: number;
      message?: string;
      errors?: { reason?: string; message?: string }[];
      response?: { status?: number; data?: unknown };
    };

    const status = Number(anyErr.status ?? anyErr.response?.status ?? anyErr.code);
    const reason = anyErr.errors?.[0]?.reason ?? '';
    const message = anyErr.message ?? 'Gmail send failed';

    let kind: SendErrorKind = 'UNKNOWN';
    if (status === 401 || reason === 'authError' || /invalid_grant|unauthorized/i.test(message)) {
      kind = 'AUTH';
      await markAccountExpired(this.account.id, message);
    } else if (status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      kind = 'RATE_LIMIT';
    } else if (reason === 'quotaExceeded' || /quota/i.test(message)) {
      kind = 'QUOTA';
    } else if (status === 400 && /invalid.*(address|recipient)|malformed/i.test(message)) {
      kind = 'INVALID_RECIPIENT';
    } else if (status >= 500 || /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(message)) {
      kind = 'TRANSIENT';
    } else if (status === 403) {
      // 403 covers both "scope not granted" and rate limiting; the reason
      // string disambiguates.
      kind = /rate/i.test(reason) ? 'RATE_LIMIT' : 'AUTH';
      if (kind === 'AUTH') await markAccountExpired(this.account.id, message);
    }

    return new SendEmailError(message, kind, String(anyErr.code ?? status ?? ''), anyErr.response?.data);
  }
}
