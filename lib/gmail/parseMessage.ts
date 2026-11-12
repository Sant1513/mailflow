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
  /** The machine-readable parts of a delivery / complaint report (lib/email/dsn.ts), when present. */
  report?: ReportParts | null;
}

/**
 * Parts of a multipart/report: the message/delivery-status body (RFC 3464), a feedback report
 * (ARF spam complaint), and the headers of the original message the report is about
 * (text/rfc822-headers or the attached message/rfc822).
 */
export interface ReportParts {
  deliveryStatus: string | null;
  feedbackReport: string | null;
  originalHeaders: Record<string, string> | null;
}

/** "Name: value" header lines (with folded continuations) into a lower-cased map. */
export function parseHeaderBlock(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  let last: string | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      if (Object.keys(map).length) break; // end of the header block
      continue;
    }
    if (/^[ \t]/.test(line) && last) {
      map[last] = `${map[last]} ${line.trim()}`;
      continue;
    }
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!m) {
      last = null;
      continue;
    }
    const key = m[1]!.toLowerCase();
    if (!(key in map)) {
      map[key] = m[2]!.trim();
      last = key;
    } else {
      last = null;
    }
  }
  return map;
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

interface WalkAcc {
  plain: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
  report: ReportParts;
  /** Inside an attached message/rfc822: its text is the original's, not this message's. */
  inner?: WalkAcc;
}

/**
 * Walks the MIME tree collecting the first text/plain, first text/html, attachments, and the
 * parts of a delivery report. The text of an attached message (the copy of the original a
 * bounce carries) is only used when the message has no text of its own.
 */
function walkParts(part: GmailPart | null | undefined, acc: WalkAcc, insideAttachedMessage = false): void {
  if (!part) return;
  const mime = (part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';

  if (mime === 'message/delivery-status' || mime === 'message/global-delivery-status') {
    const text = decodeBase64Url(part.body?.data);
    if (text && !insideAttachedMessage) acc.report.deliveryStatus = acc.report.deliveryStatus ? `${acc.report.deliveryStatus}\n\n${text}` : text;
    return;
  }
  if (mime === 'message/feedback-report') {
    const text = decodeBase64Url(part.body?.data);
    if (text && !insideAttachedMessage) acc.report.feedbackReport = text;
    return;
  }
  if ((mime === 'text/rfc822-headers' || mime === 'text/global-headers') && !insideAttachedMessage && !acc.report.originalHeaders) {
    const text = decodeBase64Url(part.body?.data);
    if (text) acc.report.originalHeaders = parseHeaderBlock(text);
    if (!filename) return;
  }
  if ((mime === 'message/rfc822' || mime === 'message/global') && !insideAttachedMessage) {
    // Gmail gives the attached message's own headers on its first child part; a raw body is
    // parsed when that's all there is.
    if (!acc.report.originalHeaders) {
      const childHeaders = headerMap(part.parts?.[0]?.headers);
      if (childHeaders['message-id'] || childHeaders['to'] || childHeaders['subject']) acc.report.originalHeaders = childHeaders;
      else if (part.body?.data) acc.report.originalHeaders = parseHeaderBlock(decodeBase64Url(part.body.data));
    }
    if (filename) {
      acc.attachments.push({ filename, mimeType: mime, size: part.body?.size ?? 0, gmailAttachmentId: part.body?.attachmentId ?? null });
      return;
    }
    acc.inner = acc.inner ?? { plain: null, html: null, attachments: acc.attachments, report: acc.report };
    for (const child of part.parts ?? []) walkParts(child, acc.inner, true);
    return;
  }

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

  for (const child of part.parts ?? []) walkParts(child, acc, insideAttachedMessage);
}

export function parseGmailMessage(message: GmailMessage): ParsedMessage {
  if (!message.id || !message.threadId) {
    throw new Error('Gmail message is missing id or threadId.');
  }

  const headers = headerMap(message.payload?.headers);
  const acc: WalkAcc = { plain: null, html: null, attachments: [], report: { deliveryStatus: null, feedbackReport: null, originalHeaders: null } };
  walkParts(message.payload, acc);
  // A message whose only text is inside an attached message (forwarded as attachment) keeps that text.
  if (acc.plain === null && acc.html === null && acc.inner) {
    acc.plain = acc.inner.plain;
    acc.html = acc.inner.html;
  }
  const hasReport = !!(acc.report.deliveryStatus || acc.report.feedbackReport || acc.report.originalHeaders);

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
    report: hasReport ? acc.report : null,
  };
}

/** Strips a "Re: Re: Fwd:" prefix pile so subjects compare sensibly. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim();
}
