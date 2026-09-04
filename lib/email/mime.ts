import crypto from 'node:crypto';
import type { EmailAttachment } from './provider';

/**
 * RFC 2822 message construction.
 *
 * Threading (§46) is what most of this exists for: Gmail's own `threadId`
 * is not enough on its own — mail clients thread on the `In-Reply-To` and
 * `References` headers, so a reply we send must carry the Message-ID of the
 * message it answers, and the full References chain. Getting this wrong is
 * how a conversation fragments into separate threads in the student's inbox.
 */

export interface BuildMessageInput {
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
  inReplyTo?: string | null;
  references?: string | null;
  /** Overridable for deterministic tests. */
  messageId?: string;
  date?: Date;
}

export interface BuiltMessage {
  raw: string;
  messageIdHeader: string;
}

/** Generates a globally-unique RFC Message-ID for an outgoing message. */
export function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] ?? 'mailflow.local';
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * RFC 2047 encodes a header value when it contains non-ASCII, so subjects
 * with accents/emoji don't arrive as mojibake.
 */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Formats a display name + address, quoting the name when required. */
export function formatAddress(name: string | undefined, email: string): string {
  if (!name?.trim()) return email;
  const encoded = encodeHeaderValue(name);
  // A quoted-string can't contain a bare '"' or '\'
  const safe = encoded.replace(/[\\"]/g, '');
  return `"${safe}" <${email}>`;
}

/**
 * Strips CR/LF from a header value. Without this, a crafted subject or
 * display name could inject extra headers (SMTP header injection) — e.g. a
 * template variable resolving to "x\r\nBcc: attacker@evil.com".
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function encodeBase64Lines(input: Buffer | string): string {
  const b64 = Buffer.isBuffer(input) ? input.toString('base64') : Buffer.from(input, 'utf8').toString('base64');
  return b64.replace(/(.{76})/g, '$1\r\n');
}

export function buildMimeMessage(input: BuildMessageInput): BuiltMessage {
  const messageId = input.messageId ?? generateMessageId(input.fromEmail);
  const date = input.date ?? new Date();
  const boundaryAlt = `alt_${crypto.randomBytes(12).toString('hex')}`;
  const boundaryMixed = `mix_${crypto.randomBytes(12).toString('hex')}`;
  const hasAttachments = (input.attachments?.length ?? 0) > 0;

  const headers: string[] = [
    `From: ${formatAddress(sanitizeHeaderValue(input.fromName), input.fromEmail)}`,
    `To: ${sanitizeHeaderValue(input.to)}`,
  ];
  if (input.cc?.length) headers.push(`Cc: ${input.cc.map(sanitizeHeaderValue).join(', ')}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.map(sanitizeHeaderValue).join(', ')}`);
  if (input.replyTo) headers.push(`Reply-To: ${sanitizeHeaderValue(input.replyTo)}`);
  headers.push(`Subject: ${encodeHeaderValue(sanitizeHeaderValue(input.subject))}`);
  headers.push(`Message-ID: ${messageId}`);
  headers.push(`Date: ${date.toUTCString()}`);
  headers.push('MIME-Version: 1.0');

  // Threading headers — only present when replying (§46/§54).
  if (input.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${sanitizeHeaderValue(input.references)}`);

  const plain = input.plainText?.trim()
    ? input.plainText
    : // A text/plain part is always included: it improves deliverability and
      // is what text-only clients and many spam filters read.
      input.html.replace(/<[^>]+>/g, '').trim();

  const altPart = [
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    '',
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBase64Lines(plain),
    '',
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBase64Lines(input.html),
    '',
    `--${boundaryAlt}--`,
  ].join('\r\n');

  let body: string;
  if (!hasAttachments) {
    body = altPart;
  } else {
    const parts = [
      `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
      '',
      `--${boundaryMixed}`,
      altPart,
      '',
    ];
    for (const attachment of input.attachments ?? []) {
      parts.push(
        `--${boundaryMixed}`,
        `Content-Type: ${attachment.mimeType}; name="${sanitizeHeaderValue(attachment.filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${sanitizeHeaderValue(attachment.filename)}"`,
        '',
        encodeBase64Lines(attachment.content),
        ''
      );
    }
    parts.push(`--${boundaryMixed}--`);
    body = parts.join('\r\n');
  }

  return { raw: `${headers.join('\r\n')}\r\n${body}`, messageIdHeader: messageId };
}

/** Gmail's API wants base64url with no padding. */
export function toGmailRaw(rfc2822: string): string {
  return Buffer.from(rfc2822, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Appends a Message-ID to an existing References chain, keeping order and
 * avoiding duplicates. RFC 5322 says References should list the whole
 * ancestry, oldest first.
 */
export function buildReferences(existing: string | null | undefined, parentMessageId: string | null | undefined): string | null {
  const ids = (existing ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parentMessageId && !ids.includes(parentMessageId)) ids.push(parentMessageId);
  return ids.length ? ids.join(' ') : null;
}
