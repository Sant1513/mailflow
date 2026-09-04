/**
 * §31 Email provider abstraction. Gmail is the first implementation; SMTP /
 * SendGrid / SES / Resend can be added without touching campaign, batch, or
 * worker code. Nothing outside lib/email/* and lib/gmail/* may import the
 * Gmail SDK directly.
 */

export interface SendEmailInput {
  to: string;
  cc?: string[];
  bcc?: string[];
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  subject: string;
  html: string;
  plainText?: string | null;
  attachments?: EmailAttachment[];
  /**
   * Threading (§46/§54). Supply all three to continue an existing thread;
   * omit them to start a new one.
   */
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  /** Raw bytes. Kept as Buffer so providers can encode as they need. */
  content: Buffer;
}

export interface SendEmailResult {
  providerMessageId: string;
  threadId: string | null;
  /** The RFC Message-ID header, needed to thread future replies (§46). */
  messageIdHeader: string | null;
  raw?: unknown;
}

/**
 * Errors are classified so the queue knows whether retrying could ever help
 * (§42: "Never retry permanent failures indefinitely").
 */
export type SendErrorKind =
  | 'AUTH' // token revoked/expired — needs the user to reconnect
  | 'RATE_LIMIT' // back off and retry
  | 'INVALID_RECIPIENT' // permanent, do not retry
  | 'QUOTA' // daily sending limit reached
  | 'TRANSIENT' // network/5xx — retry
  | 'UNKNOWN';

export class SendEmailError extends Error {
  constructor(
    message: string,
    readonly kind: SendErrorKind,
    readonly code?: string,
    readonly providerResponse?: unknown
  ) {
    super(message);
    this.name = 'SendEmailError';
  }

  /** Whether the queue should schedule another attempt. */
  get retryable(): boolean {
    return this.kind === 'RATE_LIMIT' || this.kind === 'TRANSIENT' || this.kind === 'QUOTA';
  }
}

export interface EmailProvider {
  readonly name: string;
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
}
