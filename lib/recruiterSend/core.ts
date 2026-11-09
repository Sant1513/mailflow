import { createHmac, timingSafeEqual } from 'node:crypto';
import { appBaseUrl } from '@/lib/app-url';
import { buildUnsubscribeUrl } from '@/lib/email/tracking';
import { parseCsvFile, parseXlsxFile, parsePastedText, guessEmailColumn, type ParsedTable } from '@/lib/imports/parse';
import { isValidEmail, mostlyEmailColumn, textToHtml } from '@/lib/quickSend/prepare';
import { inlineEmailCss, looksLikeHtml } from '@/lib/quickSend/html';

/**
 * Recruiter Bulk Send (Mail → Recruiter Bulk Send): one email to many recruiters, kept apart
 * from campaigns. Two ways out:
 *   BCC        — groups of up to 250 in Bcc, a fixed visible To. One Gmail message per group,
 *                so opens are counted per group (every recipient loads the same image).
 *   INDIVIDUAL — every recruiter gets their own copy, so opens are known per recruiter.
 * Only opens are tracked; links are left exactly as written.
 */

export const MAX_GROUP_SIZE = 250;
export const MODES = ['BCC', 'INDIVIDUAL'] as const;
export type BlastMode = (typeof MODES)[number];
/** Pause between messages, seconds: BCC groups default to a minute, individual copies to 3 s. */
export const DEFAULT_GAP: Record<BlastMode, number> = { BCC: 60, INDIVIDUAL: 3 };
export const MIN_GAP: Record<BlastMode, number> = { BCC: 30, INDIVIDUAL: 3 };

export interface Recipient {
  email: string;
  name: string | null;
  /** The recruiter's whole row ({ column: value }), when the list had columns. */
  data?: Record<string, string>;
}

/** A list with columns: who is in it, every column (in order) and which one holds the address. */
export interface RecipientList {
  recipients: Recipient[];
  columns: string[];
  emailColumn: string | null;
  unreadable: string[];
  error?: string;
}

const NAME_HEADER = /^(full ?)?name$|recruiter|contact name|^poc/i;

/** A table (pasted from Sheets/Excel, or a file) → recipients with their whole row kept. */
export function recipientsFromTable(table: ParsedTable, emailColumn?: string | null): RecipientList {
  const headers = table.headers.map((h) => h.trim()).filter(Boolean).slice(0, 60);
  const chosen = emailColumn && headers.includes(emailColumn) ? emailColumn : null;
  const emailHeader = chosen ?? guessEmailColumn(headers) ?? mostlyEmailColumn({ headers, rows: table.rows });
  if (!emailHeader) return { recipients: [], columns: headers, emailColumn: null, unreadable: [], error: 'No column of email addresses found. Name a column "Email", or choose it.' };
  const nameHeader = headers.find((h) => h !== emailHeader && NAME_HEADER.test(h)) ?? null;
  const found = new Map<string, Recipient>();
  const unreadable: string[] = [];
  for (const row of table.rows) {
    const value = String(row[emailHeader] ?? '').trim();
    const email = (value.match(EMAIL_IN_TEXT)?.[0] ?? '').toLowerCase();
    if (!email) {
      const line = headers.map((h) => String(row[h] ?? '').trim()).filter(Boolean).join(' · ');
      if (line) unreadable.push(line.slice(0, 120));
      continue;
    }
    if (found.has(email)) continue;
    const data: Record<string, string> = {};
    for (const h of headers) data[h] = String(row[h] ?? '').trim().slice(0, 2000);
    found.set(email, { email, name: nameHeader ? data[nameHeader] || null : null, data });
  }
  return { recipients: [...found.values()], columns: headers, emailColumn: emailHeader, unreadable };
}

/** Pasted text with a header row and columns (tab- or comma-separated, no address in the first line). */
export function looksLikeTable(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const first = lines[0]!;
  if (/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(first)) return false;
  const cells = first.split(first.includes('\t') ? '\t' : ',').filter((c) => c.trim());
  return cells.length >= 2 || /^e-?mail/i.test(first);
}

/** A pasted list: a table with a header row keeps all its columns; otherwise lines of addresses. */
export function parseRecipientPaste(text: string, emailColumn?: string | null): RecipientList {
  if (looksLikeTable(text)) return recipientsFromTable(parsePastedText(text), emailColumn);
  const { recipients, unreadable } = parseRecipientText(text);
  return { recipients, columns: [], emailColumn: null, unreadable };
}

const EMAIL_IN_TEXT = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** A pasted list: one per line, "Name <email>", "Name, email", or addresses separated by commas/spaces. */
export function parseRecipientText(text: string): { recipients: Recipient[]; unreadable: string[] } {
  const found = new Map<string, Recipient>();
  const unreadable: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const emails = line.match(EMAIL_IN_TEXT) ?? [];
    if (!emails.length) {
      unreadable.push(line.slice(0, 120));
      continue;
    }
    // A name is only taken when the line holds exactly one address.
    const name =
      emails.length === 1
        ? line.replace(emails[0]!, '').replace(/[<>"(),;\t]/g, ' ').replace(/\s+/g, ' ').trim() || null
        : null;
    for (const e of emails) {
      const email = e.toLowerCase();
      if (!found.has(email)) found.set(email, { email, name: name && name.length <= 120 ? name : null });
    }
  }
  return { recipients: [...found.values()], unreadable };
}

/** A CSV/Excel upload: every column is kept; the email column is found by name, else by its contents (or as chosen). */
export function parseRecipientFile(buffer: Buffer, fileName: string, emailColumn?: string | null): RecipientList {
  let table: ParsedTable;
  try {
    table = /\.xlsx?$/i.test(fileName) ? parseXlsxFile(buffer) : parseCsvFile(buffer);
  } catch {
    return { recipients: [], columns: [], emailColumn: null, unreadable: [], error: 'That file could not be read. Upload a CSV or Excel file.' };
  }
  return recipientsFromTable(table, emailColumn);
}

export function validRecipient(r: Recipient): boolean {
  return isValidEmail(r.email);
}

/** The email body as sent: simple text becomes the same clean layout as Quick Send; HTML has its CSS inlined. */
export function buildBody(input: { body: string; format: string; signature: string | null; videoCard?: string | null }): { html: string; plainText: string } {
  const isHtml = input.format === 'html' || looksLikeHtml(input.body);
  const messageHtml = isHtml ? inlineEmailCss(input.body) : textToHtml(input.body);
  // A link video's "Watch the video" button goes after the message, before the signature.
  const signatureBlock = `${input.videoCard ?? ''}${input.signature ? `\n<br>\n<div class="signature">${input.signature}</div>` : ''}`;
  const html = signatureBlock && /<\/body>/i.test(messageHtml) ? messageHtml.replace(/<\/body>/i, `${signatureBlock}</body>`) : messageHtml + signatureBlock;
  const plainText = html
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { html, plainText };
}

// ── Open tracking: one signed token per Gmail message (group) ──
const KEY = process.env.ENCRYPTION_KEY ?? 'dev-tracking-key-32chars-padding!!';
const sign = (data: string) => createHmac('sha256', KEY).update(`rb:${data}`).digest('hex').slice(0, 20);

export function openToken(groupId: string): string {
  return `${groupId}.${sign(groupId)}`;
}

export function readOpenToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(id);
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

/** The unsubscribe page for a BCC email: the recruiter types their address (we can't know who clicked). */
export function listUnsubscribeToken(blastId: string): string {
  return `${blastId}.${sign(`unsub:${blastId}`)}`;
}

export function readListUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(`unsub:${id}`);
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

/** Adds the open pixel and an unsubscribe line before </body>. Links are not touched. */
/**
 * The Reply-To header for a recruiter email. With a custom Reply-To, a recruiter's reply (and
 * reply-all) went ONLY there, so the sending mailbox never got it and MailFlow couldn't track
 * it. Both addresses are listed, so every reply also reaches the sending mailbox.
 */
export function replyToHeader(replyTo: string | null | undefined, sendingAddress: string): string | undefined {
  const custom = replyTo?.trim();
  if (!custom) return undefined; // replies go to the sender (From) anyway
  if (custom.toLowerCase() === sendingAddress.trim().toLowerCase()) return custom;
  return `${custom}, ${sendingAddress.trim()}`;
}

/**
 * The Unsubscribe button at the bottom of every bulk email. With `mailto` (an email to the
 * sending mailbox) the button sends that email, which says exactly who unsubscribed even in a
 * BCC email; `href` is the web page, offered as a small link too.
 */
/** An email to the sending mailbox asking to unsubscribe (read by lib/email/unsubscribeByEmail.ts). */
export function unsubscribeMailtoFor(sendingAddress: string, code: string): string {
  return `mailto:${sendingAddress.trim()}?subject=${encodeURIComponent(`Unsubscribe ${code}`)}&body=${encodeURIComponent('Please unsubscribe me from these emails.')}`;
}

export function unsubscribeButtonHtml(opts: { href: string; mailto?: string | null; primary?: 'mailto' | 'href' }): string {
  const primary = opts.primary === 'mailto' && opts.mailto ? opts.mailto : opts.href;
  const secondary = primary === opts.href ? null : opts.href;
  return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:28px auto 0;border-collapse:collapse"><tr><td align="center" style="font:12px/1.5 Arial,Helvetica,sans-serif;color:#888">
<a href="${primary}" style="display:inline-block;padding:6px 16px;border:1px solid #cfcfcf;border-radius:999px;color:#555;text-decoration:none;font:600 12px/1.4 Arial,Helvetica,sans-serif">Unsubscribe</a>
<div style="margin-top:6px">Don't want these emails? Click Unsubscribe${secondary ? ` (or <a href="${secondary}" style="color:#888">unsubscribe on the web</a>)` : ''}.</div>
</td></tr></table>`;
}

export function decorate(html: string, opts: { groupId: string; mode: BlastMode; workspaceId: string; blastId: string; recipientEmail?: string; pixel?: boolean; sendingAddress?: string }): {
  html: string;
  unsubscribeUrl: string;
  unsubscribeMailto: string | null;
} {
  const base = appBaseUrl();
  const unsubscribeUrl =
    opts.mode === 'INDIVIDUAL' && opts.recipientEmail
      ? buildUnsubscribeUrl(opts.workspaceId, opts.recipientEmail)
      : `${base}/unsubscribe/list/${listUnsubscribeToken(opts.blastId)}`;
  // BCC: the button sends an email from the recruiter (so we know who); individual copies: their own link.
  const unsubscribeMailtoLink = opts.sendingAddress ? unsubscribeMailtoFor(opts.sendingAddress, `rb-${listUnsubscribeToken(opts.blastId)}`) : null;
  const footer = unsubscribeButtonHtml({ href: unsubscribeUrl, mailto: unsubscribeMailtoLink, primary: opts.mode === 'BCC' ? 'mailto' : 'href' });
  const pixel = `<img src="${base}/api/track/rb/${openToken(opts.groupId)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
  const extra = opts.pixel === false ? footer : `${footer}${pixel}`;
  return { html: /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${extra}</body>`) : html + extra, unsubscribeUrl, unsubscribeMailto: unsubscribeMailtoLink };
}

/** The email as recruiters will see it (unsubscribe line included), for previews: no open pixel, so a preview never counts as an open. */
export function previewHtml(blast: { id: string; html: string; mode: string; workspaceId: string }): string {
  if (!blast.html) return '';
  return decorate(blast.html, { groupId: 'preview', mode: blast.mode as BlastMode, workspaceId: blast.workspaceId, blastId: blast.id, recipientEmail: 'recruiter@example.com', pixel: false }).html;
}

/** Recipients split into the Gmail messages that will carry them. */
export function planGroups<T>(recipients: T[], mode: BlastMode, groupSize: number): T[][] {
  const size = mode === 'INDIVIDUAL' ? 1 : Math.max(1, Math.min(MAX_GROUP_SIZE, groupSize));
  const groups: T[][] = [];
  for (let i = 0; i < recipients.length; i += size) groups.push(recipients.slice(i, i + size));
  return groups;
}
