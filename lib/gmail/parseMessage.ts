/**
 * Turns a raw Gmail API message (users.messages.get, format=full) into a
 * structured, provider-agnostic shape.
 *
 * Pure: no I/O, no database. Everything the inbound pipeline needs to
 * thread, classify and store a message comes out of here, which is what
 * makes ingestion testable without contacting Gmail.
 */

export interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

export interface GmailPart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: GmailHeader[] | null;
  body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
  parts?: GmailPart[] | null;
}

export interface GmailMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  internalDate?: string | null;
  payload?: GmailPart | null;
}

export interface ParsedAddress {
  name: string | null;
  email: string;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  gmailAttachmentId: string | null;
}

export interface ParsedMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  labelIds: string[];
  snippet: string;
  /** Gmail's internalDate (ms since epoch) — when Gmail received it. */
  receivedAt: Date;
  /** The Date header, when present; falls back to receivedAt. */
  sentAt: Date;
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  htmlBody: string | null;
  plainTextBody: string | null;
  attachments: ParsedAttachment[];
  /** Raw header map (lower-cased names) for the classifier. */
  headers: Record<string, string>;
}

/** Gmail encodes bodies as base64url without padding. */
export function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return '';
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Parses "Name <addr@x>", "addr@x", or a comma-separated list of either.
 * Tolerant of quoting and stray whitespace; skips anything with no "@".
 */
export function parseAddressList(value: string | null | undefined): ParsedAddress[] {
  if (!value) return [];
  const out: ParsedAddress[] = [];
  // Split on commas that are not inside quotes.
  const parts = value.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/^(.*?)<([^>]+)>\s*$/);
    if (angle) {
      const email = angle[2]!.trim().toLowerCase();
      if (!email.includes('@')) continue;
      const name = angle[1]!.trim().replace(/^"|"$/g, '').trim() || null;
      out.push({ name, email });
    } else if (part.includes('@')) {
      out.push({ name: null, email: part.replace(/^"|"$/g, '').trim().toLowerCase() });
    }
  }
  return out;
}

function headerMap(headers: GmailHeader[] | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (!h.name) continue;
    const key = h.name.toLowerCase();
    // First occurrence wins for singletons; Received etc. can repeat but we
    // don't need those.
    if (!(key in map)) map[key] = h.value ?? '';
  }
  return map;
}

/** Walks the MIME tree collecting the first text/plain, first text/html, and attachments. */
function walkParts(
  part: GmailPart | null | undefined,
  acc: { plain: string | null; html: string | null; attachments: ParsedAttachment[] }
): void {
  if (!part) return;
  const mime = (part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';

  if (filename) {
    acc.attachments.push({
      filename,
      mimeType: mime || 'application/octet-stream',
      size: part.body?.size ?? 0,
      gmailAttachmentId: part.body?.attachmentId ?? null,
    });
  } else if (mime === 'text/plain' && acc.plain === null && part.body?.data) {
    acc.plain = decodeBase64Url(part.body.data);
  } else if (mime === 'text/html' && acc.html === null && part.body?.data) {
    acc.html = decodeBase64Url(part.body.data);
  }

  for (const child of part.parts ?? []) walkParts(child, acc);
}

export function parseGmailMessage(message: GmailMessage): ParsedMessage {
  if (!message.id || !message.threadId) {
    throw new Error('Gmail message is missing id or threadId.');
  }

  const headers = headerMap(message.payload?.headers);
  const acc = { plain: null as string | null, html: null as string | null, attachments: [] as ParsedAttachment[] };
  walkParts(message.payload, acc);

  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : new Date();
  const dateHeader = headers['date'] ? new Date(headers['date']) : null;
  const sentAt = dateHeader && !Number.isNaN(dateHeader.getTime()) ? dateHeader : receivedAt;

  const from = parseAddressList(headers['from'])[0] ?? null;

  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    labelIds: message.labelIds ?? [],
    snippet: message.snippet ?? '',
    receivedAt,
    sentAt,
    from,
    to: parseAddressList(headers['to']),
    cc: parseAddressList(headers['cc']),
    subject: headers['subject'] ?? '',
    messageIdHeader: headers['message-id']?.trim() || null,
    inReplyTo: headers['in-reply-to']?.trim() || null,
    references: headers['references']?.trim() || null,
    htmlBody: acc.html,
    plainTextBody: acc.plain,
    attachments: acc.attachments,
    headers,
  };
}

/** Strips a "Re: Re: Fwd:" prefix pile so subjects compare sensibly. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim();
}
