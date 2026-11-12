import type { ReportParts } from '@/lib/gmail/parseMessage';

/**
 * Delivery reports (bounces / NDRs / DSNs), read without any I/O.
 *
 * A mail server that can't deliver writes back to the sending mailbox. The standard form is a
 * multipart/report with a message/delivery-status part (RFC 3464: Final-Recipient, Action,
 * Status x.y.z, Diagnostic-Code); Gmail, Office 365 / Exchange, Yahoo, Zoho, Postfix and Exim
 * all send one, but the human text differs and some servers only send text. This reads the
 * structured part first and falls back to the text, then sorts every failed address into a
 * category with a plain-English remark and the server's own words.
 *
 * Also recognises two non-bounce messages that mean "stop mailing this address":
 *   - an automatic reply saying the person has left the company (LEFT_COMPANY), and
 *   - a spam-complaint feedback report (ARF, Feedback-Type: abuse → COMPLAINT).
 *
 * What happens next (suppress now / on the second time / never) is decided by suppressionRule()
 * and done by lib/email/ndr.ts.
 */

export const BOUNCE_CATEGORIES = [
  'USER_UNKNOWN',
  'DOMAIN_NOT_FOUND',
  'MAILBOX_DISABLED',
  'MAILBOX_FULL',
  'POLICY_BLOCK',
  'SPAM_BLOCK',
  'MESSAGE_TOO_LARGE',
  'TEMPORARY',
  'OTHER_HARD',
  'LEFT_COMPANY',
  'COMPLAINT',
] as const;
export type BounceCategory = (typeof BOUNCE_CATEGORIES)[number];

export function isBounceCategory(v: unknown): v is BounceCategory {
  return typeof v === 'string' && (BOUNCE_CATEGORIES as readonly string[]).includes(v);
}

/** One plain-English sentence per category (stored as the suppression's remark). */
export const CATEGORY_REMARK: Record<BounceCategory, string> = {
  USER_UNKNOWN: "Address doesn't exist",
  DOMAIN_NOT_FOUND: "Domain doesn't exist or has no mail server",
  MAILBOX_DISABLED: 'Mailbox is disabled or inactive',
  MAILBOX_FULL: 'Mailbox is full',
  POLICY_BLOCK: "Blocked by the recipient's mail policy",
  SPAM_BLOCK: 'Rejected as spam or failed sender authentication',
  MESSAGE_TOO_LARGE: 'Message was too large',
  TEMPORARY: 'Temporary delivery problem',
  OTHER_HARD: 'Permanent delivery failure',
  LEFT_COMPANY: 'Has left the organisation (automatic reply)',
  COMPLAINT: 'Marked our email as spam',
};

/** Short badge text. */
export const CATEGORY_LABEL: Record<BounceCategory, string> = {
  USER_UNKNOWN: 'Address not found',
  DOMAIN_NOT_FOUND: 'Domain not found',
  MAILBOX_DISABLED: 'Mailbox disabled',
  MAILBOX_FULL: 'Mailbox full',
  POLICY_BLOCK: 'Blocked by policy',
  SPAM_BLOCK: 'Spam block',
  MESSAGE_TOO_LARGE: 'Too large',
  TEMPORARY: 'Temporary',
  OTHER_HARD: 'Hard bounce',
  LEFT_COMPANY: 'Left company',
  COMPLAINT: 'Complaint',
};

/**
 * NOW: suppress on the first notice. ON_REPEAT: only after a second notice within
 * SOFT_REPEAT_WINDOW_DAYS (a full mailbox is often emptied). NEVER: a delay, or a problem with
 * the message rather than the address (too large).
 */
export type SuppressionRule = 'NOW' | 'ON_REPEAT' | 'NEVER';
export const SOFT_REPEAT_WINDOW_DAYS = 30;

export function suppressionRule(category: BounceCategory): SuppressionRule {
  if (category === 'MAILBOX_FULL') return 'ON_REPEAT';
  if (category === 'TEMPORARY' || category === 'MESSAGE_TOO_LARGE') return 'NEVER';
  return 'NOW';
}

/** EmailSuppression.reason for a category (kept to the existing three values). */
export function suppressionReason(category: BounceCategory): 'BOUNCED' | 'COMPLAINT' {
  return category === 'COMPLAINT' ? 'COMPLAINT' : 'BOUNCED';
}

export interface DeliveryFailure {
  /** The failed address (lower-cased), or null when the notice doesn't say (the matched send decides). */
  email: string | null;
  /** RFC 3464 Action, when the report had one. */
  action: string | null;
  /** True when the server gave up (Action: failed, a 5xx, or Gmail's "Message blocked"); false for a delay. */
  final: boolean;
  /** Enhanced status (5.1.1) when known, else the SMTP reply code (550). */
  statusCode: string | null;
  /** The server's own words, trimmed. */
  diagnostic: string | null;
  category: BounceCategory;
  remark: string;
}

export interface DeliveryReport {
  kind: 'BOUNCE' | 'COMPLAINT' | 'LEFT_COMPANY';
  failures: DeliveryFailure[];
  /** In-Reply-To / References of the notice plus the embedded original Message-ID. */
  referencedIds: string[];
  originalMessageId: string | null;
  /** To/Cc of the embedded original, when the notice carried its headers. */
  originalRecipients: string[];
}

export interface ReportSource {
  subject?: string | null;
  from?: { email: string; name: string | null } | null;
  headers?: Record<string, string>;
  plainTextBody: string | null;
  htmlBody: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  report?: ReportParts | null;
}

const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const DAEMON = /^(?:mailer-daemon|postmaster|mail-daemon|mailerdaemon|mail\.?delivery|bounces?|microsoftexchange[0-9a-f]*)(?:[+-][^@]*)?@/i;

// ───────────────────────────── text helpers ─────────────────────────────

/** Plain text of a message: the text part plus the HTML part with its tags taken out. */
export function textOf(message: { plainTextBody: string | null; htmlBody: string | null }): string {
  const fromHtml = (message.htmlBody ?? '')
    .replace(/<(?:style|script|head)\b[\s\S]*?<\/(?:style|script|head)>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h\d|\/td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
  return `${message.plainTextBody ?? ''}\n${fromHtml}`.replace(/\r\n?/g, '\n');
}

/** Cuts the notice before the copy of the original message many servers append. */
function ownPart(text: string): string {
  const cut = text.search(
    /^\s*(?:-{2,}\s*)?(?:Below this line is a copy of the message|This is a copy of the message|Original message headers:?|-+\s*Original message\s*-+|-+ ?Original Message Headers ?-+|------ This is a copy|The original message was received|Return-Path:\s)/im,
  );
  return cut > 0 ? text.slice(0, cut) : text;
}

function clean(s: string | null | undefined, max = 300): string | null {
  const t = (s ?? '').replace(/\s+/g, ' ').replace(/^[\s'"]+|[\s'"]+$/g, '').trim();
  return t ? t.slice(0, max) : null;
}

function normalizeEmail(raw: string): string {
  return raw.toLowerCase().replace(/^[<("']+|[>)"'.,;:]+$/g, '');
}

function idsIn(value: string | null | undefined): string[] {
  return (value ?? '').match(/<[^<>\s]+>/g) ?? [];
}

// ─────────────────────── RFC 3464 delivery-status ───────────────────────

interface StatusRecipient {
  email: string;
  action: string | null;
  status: string | null;
  diagnostic: string | null;
}

function unfoldBlocks(text: string): Map<string, string>[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Map<string, string>[] = [];
  let current = new Map<string, string>();
  let lastKey: string | null = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (current.size) blocks.push(current);
      current = new Map();
      lastKey = null;
      continue;
    }
    if (/^[ \t]/.test(line) && lastKey) {
      current.set(lastKey, `${current.get(lastKey)} ${line.trim()}`);
      continue;
    }
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (m) {
      const key = m[1]!.toLowerCase();
      // A new recipient inside the same block (no blank line between them) starts a new block.
      if (key === 'final-recipient' && current.has('final-recipient')) {
        blocks.push(current);
        current = new Map();
      }
      if (!current.has(key)) current.set(key, m[2]!.trim());
      lastKey = key;
    } else {
      lastKey = null;
    }
  }
  if (current.size) blocks.push(current);
  return blocks;
}

function addressField(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.replace(/^\s*rfc822\s*;/i, '').match(EMAIL);
  return m?.[0] ? normalizeEmail(m[0]) : null;
}

/** Per-recipient fields of a message/delivery-status body (or text that quotes one). */
export function parseDeliveryStatus(text: string): StatusRecipient[] {
  const out: StatusRecipient[] = [];
  for (const block of unfoldBlocks(text)) {
    const email = addressField(block.get('final-recipient')) ?? addressField(block.get('original-recipient'));
    if (!email) continue;
    const status = block.get('status')?.match(/[245]\.\d{1,3}\.\d{1,3}/)?.[0] ?? null;
    const diagnostic = clean(block.get('diagnostic-code')?.replace(/^\s*(?:smtp|x-[a-z-]+)\s*;\s*/i, ''));
    out.push({ email, action: block.get('action')?.trim().toLowerCase().split(/\s/)[0] ?? null, status, diagnostic });
  }
  return out;
}

// ─────────────────────────── categorising ───────────────────────────

const POLICY_STRONG = /restricted by policy|delivery restrictions|SenderNotAuthenticatedForGroup|RESOLVER\.RST\.|group restrictions?|not (?:allowed|authori[sz]ed|permitted) to (?:send|email|post|deliver|receive)|access denied|relay(?:ing)? (?:access )?(?:denied|not permitted)|relay not permitted|not permitted to relay|rejected by (?:the )?recipient(?:['’]s)? (?:domain|organi[sz]ation|policy)|sender (?:is )?(?:not allowed|blocked by (?:the )?recipient)/i;
const SPAM = /\bspam\b|spamhaus|spamcop|barracuda|sorbs|block ?list(?:ed)?|black ?list(?:ed)?|\bdnsbl\b|\brbl\b|reputation|\bdmarc\b|\bspf\b|\bdkim\b|unauthenticated|authentication (?:failed|failure|required)|not authenticated|phish|malware|virus|unsolicited|potential security issue|suspicious/i;
const TOO_LARGE = /message (?:size )?(?:is )?too (?:large|big)|exceeds? (?:the )?(?:maximum|max|allowed|message size|size)|message size (?:exceeds|limit)|maximum message size|message length exceeds/i;
const FULL = /mailbox (?:is )?full|inbox (?:is )?full|over (?:its |the |their )?quota|quota (?:exceeded|exceed|full)|exceeded (?:the |their |its )?(?:storage|quota)|insufficient (?:system )?storage|storage (?:limit|quota|space)|out of storage|overquota|mailbox size limit|not enough (?:space|storage)/i;
const DISABLED = /(?:account|mailbox|user|address|recipient)(?: [a-z]+)? (?:has been |is |was )?(?:disabled|deactivated|inactive|suspended|locked|closed|discontinued|terminated|expired)|(?:inactive|disabled|suspended|deactivated) (?:user|account|mailbox|recipient)|account is not active|no longer active/i;
const DOMAIN = /domain (?:name )?(?:not found|does(?: not|n['’]t) exist|couldn['’]t be found|could not be found|is not valid|unknown)|host (?:or domain name )?not found|no (?:mx|mail exchanger|mail server|valid mx)s?(?: records?)?(?: (?:for|found))?|unrouteable (?:address|domain)|dns error|name or service not known|nxdomain|unknown domain|bad destination (?:system|mailbox) address|domain .{1,80}? (?:couldn['’]t|could not) be found/i;
const USER = /user unknown|unknown user|no such (?:user|mailbox|recipient|address|account|person)|address (?:not found|couldn['’]t be found|could not be found|does(?: not|n['’]t) exist|is unknown|is invalid|rejected: user unknown)|(?:account|address|mailbox|user|recipient)(?: that you tried to reach)? does(?: not|n['’]t) exist|wasn['’]t found at|was not found at|recipient ?not ?found|RecipientNotFound|unknown (?:to|recipient) address|invalid (?:recipient|mailbox|address|user)|mailbox (?:unavailable|not found|does not exist)|not a valid (?:mailbox|recipient|user)|doesn['’]t have an? \S+ account|does not have an? \S+ account|no mailbox here|undeliverable address|unknown or illegal alias|recipient (?:rejected|unknown)|unknown local part/i;
const POLICY_WEAK = /\bblocked\b|\bpolicy\b|\brefused\b|\bdenied\b|\bprohibited\b/i;

function categoryFromStatus(status: string | null): BounceCategory | null {
  const m = status?.match(/^([245])\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const [, , subject, detail] = m;
  const code = `${subject}.${detail}`;
  if (['1.1', '1.10', '1.3', '1.6', '1.0'].includes(code)) return 'USER_UNKNOWN';
  if (['1.2', '4.4', '1.8'].includes(code)) return 'DOMAIN_NOT_FOUND';
  if (code === '2.1') return 'MAILBOX_DISABLED';
  if (code === '2.2') return 'MAILBOX_FULL';
  if (code === '3.4' || code === '2.3') return 'MESSAGE_TOO_LARGE';
  if (['7.23', '7.25', '7.26', '7.27', '7.7', '7.509', '7.510', '7.511'].includes(code)) return 'SPAM_BLOCK';
  if (subject === '7' || code === '4.1') return 'POLICY_BLOCK';
  return null;
}

function categoryFromText(text: string): BounceCategory | null {
  if (!text) return null;
  if (POLICY_STRONG.test(text)) return 'POLICY_BLOCK';
  if (SPAM.test(text)) return 'SPAM_BLOCK';
  if (FULL.test(text)) return 'MAILBOX_FULL';
  if (TOO_LARGE.test(text)) return 'MESSAGE_TOO_LARGE';
  if (DOMAIN.test(text)) return 'DOMAIN_NOT_FOUND';
  if (DISABLED.test(text)) return 'MAILBOX_DISABLED';
  if (USER.test(text)) return 'USER_UNKNOWN';
  return null;
}

/**
 * The category of one failure: the server's words first (most specific), then the enhanced
 * status code, then the notice's wider text, then the code's class. A delay is always TEMPORARY.
 */
export function categorize(input: { final: boolean; statusCode: string | null; diagnostic: string | null; context?: string }): BounceCategory {
  if (!input.final) return 'TEMPORARY';
  const status = input.statusCode && /^\d\.\d/.test(input.statusCode) ? input.statusCode : null;
  const smtp = input.statusCode && /^\d{3}$/.test(input.statusCode) ? input.statusCode : (input.diagnostic?.match(/(?:^|\s)([45]\d\d)(?:[\s-]|$)/)?.[1] ?? null);
  const fromDiag = categoryFromText(input.diagnostic ?? '');
  if (fromDiag) return fromDiag;
  const fromStatus = categoryFromStatus(status);
  if (fromStatus) return fromStatus;
  const fromContext = categoryFromText(input.context ?? '');
  if (fromContext) return fromContext;
  const cls = status?.[0] ?? smtp?.[0] ?? null;
  if (POLICY_WEAK.test(`${input.diagnostic ?? ''}\n${input.context ?? ''}`) && cls !== '4') return 'POLICY_BLOCK';
  if (cls === '5') return 'OTHER_HARD';
  if (cls === '4') return 'TEMPORARY';
  return 'OTHER_HARD';
}

// ─────────────────────────── text fallbacks ───────────────────────────

const RECIPIENT_PATTERNS: RegExp[] = [
  /x-failed-recipients:\s*([^\n]+)/gi,
  // Gmail / Office 365: "Your message to x@y has been blocked / couldn't be delivered / wasn't delivered".
  /(?:message|mail|email) (?:to|for|addressed to)\s+<?([^\s<>()"]+@[^\s<>()",;]+?)>?\s+(?:has been blocked|has been delayed|couldn['’]t be delivered|could not be delivered|wasn['’]t delivered|was not delivered|has not been delivered|is delayed|bounced|has bounced|failed|was blocked|was rejected)/gi,
  /(?:wasn['’]?t|was not|couldn['’]?t be|could not be|has not been) delivered to\s+<?([^\s<>()"]+@[^\s<>()",;]+)/gi,
  /problem delivering your message to\s+<?([^\s<>()"]+@[^\s<>()",;]+)/gi,
  /delivery to the following recipients? (?:failed|has failed)[^\n]*\n+\s*([^\n]+)/gi,
  /delivery has failed to these recipients or groups:?\s*\n+\s*([^\n]+)/gi,
  /(?:unable to deliver|could not deliver|couldn['’]t deliver) (?:your )?(?:message|mail) to(?: the following (?:address(?:es)?|recipients?))?[:.]?\s*\n*\s*<?([^\s<>()"]+@[^\s<>()",;]+)/gi,
  /could not be delivered to one or more (?:of its )?recipients[\s\S]{0,200}?<?([^\s<>()"]+@[^\s<>()",;]+?)>?(?:\s|$)/gi,
  /^\s*<([^<>\s]+@[^<>\s]+)>:?\s*(?:\n|\s)*(?:host|said|\(|[45]\d\d|[45]\.\d|recipient|user|mailbox|this user|sorry|delivery|unknown|the|account)/gim,
  /^\s*<([^<>\s]+@[^<>\s]+)>:?\s*$/gim,
  /RCPT TO:\s*<([^<>\s]+@[^<>\s]+)>/gi,
  /(?:recipient|address)(?: address)? (?:rejected|not found|unknown)[:\s]+<?([^\s<>()"]+@[^\s<>()",;]+)/gi,
  /invalid (?:address(?:es)?|recipients?)\s*[:\-]?\s*<?([^\s<>()"]+@[^\s<>()",;]+)/gi,
];

function recipientsFromText(text: string, headers: Record<string, string> | undefined, isOwn: (e: string) => boolean): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const e = normalizeEmail(raw);
    if (!e.includes('@') || isOwn(e) || DAEMON.test(e) || found.includes(e)) return;
    found.push(e);
  };
  if (headers?.['x-failed-recipients']) for (const a of headers['x-failed-recipients'].match(EMAIL) ?? []) add(a);
  for (const pattern of RECIPIENT_PATTERNS) {
    for (const m of text.matchAll(pattern)) for (const a of (m[1] ?? '').match(EMAIL) ?? []) add(a);
  }
  // Office 365: "thakurayush wasn't found at atfenix.com."
  for (const m of text.matchAll(/(?:^|[\s>])([A-Za-z0-9._%+'-]+) (?:wasn['’]t|was not) found at ([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g)) add(`${m[1]}@${m[2]}`);
  return found;
}

function statusFromText(text: string): string | null {
  return text.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] ?? text.match(/(?:^|[\s'"(:\[])([45][0-5]\d)(?:[\s-]|$)/m)?.[1] ?? null;
}

function diagnosticFromText(text: string, subject: string): string | null {
  const tries = [
    /The response (?:from the remote server )?(?:was|is):?\s*\n?\s*([^\n]+(?:\n[^\n]+)?)/i,
    /Remote server returned\s*['"‘“]?([^\n]+?)['"’”]?\s*(?:\n|$)/i,
    /Diagnostic-Code:\s*(?:smtp;\s*)?([^\n]+)/i,
    /(?:said|SMTP error from remote (?:mail )?server(?: after [^:\n]+)?):\s*\n?\s*([^\n]+)/i,
    /(?:^|\n)\s*([45]\d\d[ -][45]?\.?\d?\.?\d*[^\n]{3,})/,
    /(?:^|\n)\s*([^\n]*\b[45]\.\d{1,3}\.\d{1,3}\b[^\n]*)/,
    /(?:^|\n)\s*([^\n]*(?:wasn['’]t found at|address not found|message blocked|has been blocked|couldn['’]t be delivered|could not be delivered|user unknown|no such user|mailbox (?:is )?full|unknown to address|wasn['’]t delivered)[^\n]*)/i,
  ];
  for (const re of tries) {
    const m = text.match(re);
    const v = clean(m?.[1]);
    if (v) return v;
  }
  return clean(subject) ?? null;
}

const DELAY_SUBJECT = /\(delay\)|\bdelay(?:ed)?\b|warning:|still trying|not yet delivered/i;
const DELAY_TEXT = /will (?:retry|keep trying|continue (?:to try|trying))|still trying|has been delayed|is delayed|not (?:yet )?been delivered yet|has not yet been delivered|delivery is delayed|delayed delivery|temporarily deferred|will be retried/i;
const FINAL_TEXT = /\(failure\)|has been blocked|message blocked|wasn['’]t delivered|was not delivered|couldn['’]t be delivered|could not be delivered|message not delivered|undeliverable|undelivered|delivery (?:has )?failed|delivery failure|failed permanently|permanent(?:ly)? (?:error|failure|fatal)|gave up|giving up|failure notice|address not found|returned mail|returned to sender|wasn['’]t found at|unknown to address|will not (?:retry|be retried)|won['’]t retry|no further (?:attempts|retries)|was rejected|been rejected|could not deliver|unable to deliver/i;

function isFinal(action: string | null, status: string | null, subject: string, text: string): boolean {
  if (action === 'failed') return true;
  if (action === 'delayed' || action === 'delivered' || action === 'relayed' || action === 'expanded') return false;
  if (status && /^5/.test(status)) return true;
  const delayed = DELAY_SUBJECT.test(subject) || DELAY_TEXT.test(text);
  if (delayed) return false;
  return FINAL_TEXT.test(`${subject}\n${text}`);
}

// ─────────────────────────── recognising ───────────────────────────

const REPORT_SUBJECT = /^\s*(?:(?:re|fwd?|aw)\s*:\s*)?(?:undeliverable|undelivered mail|delivery status notification|mail delivery (?:failed|failure|subsystem|system)|returned mail|failure notice|delivery failure|message not delivered|non-?delivery|delivery has failed|message blocked|delivery (?:delayed|notification)|warning: (?:could not send|message)|mail system error|couldn['’]t be delivered|could not be delivered|address not found|undeliverable mail|delivery incomplete)/i;
const REPORT_NAME = /mail delivery (?:system|subsystem|service)|mailer[- ]?daemon|postmaster|mail administrator|microsoft outlook|delivery status|mail system/i;

/**
 * Sync triage, from headers only: does this look like a bounce / delivery report or a complaint
 * report? Such messages are fetched in full; ingestion then decides whether they are about mail
 * MailFlow sent (most NDRs from Office 365 carry no In-Reply-To, so the headers alone can't tell).
 */
export function looksLikeDeliveryReport(meta: { fromEmail: string | null; fromName?: string | null; subject?: string | null; contentType?: string | null; autoSubmitted?: string | null; failedRecipients?: string | null }): boolean {
  const from = meta.fromEmail ?? '';
  const subject = meta.subject ?? '';
  const ct = (meta.contentType ?? '').toLowerCase();
  if (ct.includes('multipart/report')) return true;
  if (meta.failedRecipients) return true;
  if (DAEMON.test(from)) return true;
  if (REPORT_SUBJECT.test(subject)) return true;
  if (meta.fromName && REPORT_NAME.test(meta.fromName) && (/auto-generated|auto-replied/i.test(meta.autoSubmitted ?? '') || /undeliver|deliver|returned|failure|blocked/i.test(subject))) return true;
  return false;
}

/** Is this message a delivery report (bounce / delay) by its full content? */
export function isDeliveryReport(message: ReportSource): boolean {
  const h = message.headers ?? {};
  const ct = (h['content-type'] ?? '').toLowerCase();
  if (ct.includes('multipart/report') && !ct.includes('feedback-report') && !ct.includes('disposition-notification')) return true;
  if (message.report?.deliveryStatus) return true;
  return looksLikeDeliveryReport({ fromEmail: message.from?.email ?? null, fromName: message.from?.name ?? null, subject: message.subject ?? null, contentType: null, autoSubmitted: h['auto-submitted'] ?? null, failedRecipients: h['x-failed-recipients'] ?? null });
}

export function isComplaintReport(message: ReportSource): boolean {
  const ct = (message.headers?.['content-type'] ?? '').toLowerCase();
  if (ct.includes('feedback-report')) return true;
  return /^\s*feedback-type:\s*(?:abuse|fraud)/im.test(message.report?.feedbackReport ?? '');
}

// ─────────────────────────── the parser ───────────────────────────

function originalOf(message: ReportSource, ownAddresses: Set<string>) {
  const oh = message.report?.originalHeaders ?? null;
  const originalMessageId = idsIn(oh?.['message-id'])[0] ?? null;
  const originalRecipients = [...(oh?.['to'] ?? '').matchAll(EMAIL), ...(oh?.['cc'] ?? '').matchAll(EMAIL)]
    .map((m) => normalizeEmail(m[0]))
    .filter((e) => !ownAddresses.has(e));
  return { originalMessageId, originalRecipients: [...new Set(originalRecipients)] };
}

function referencedOf(message: ReportSource, originalMessageId: string | null): string[] {
  const ids = [...idsIn(message.inReplyTo), ...idsIn(message.references), ...(originalMessageId ? [originalMessageId] : [])];
  // Some notices quote the original's Message-ID only in the text ("Original-Envelope-Id", the copy).
  return [...new Set(ids)];
}

function failure(email: string | null, action: string | null, statusCode: string | null, diagnostic: string | null, context: string, subject: string): DeliveryFailure {
  const final = isFinal(action, statusCode, subject, `${diagnostic ?? ''}\n${context}`);
  const category = categorize({ final, statusCode, diagnostic, context: `${subject}\n${context}` });
  return { email, action, final, statusCode, diagnostic, category, remark: CATEGORY_REMARK[category] };
}

/**
 * Reads a bounce / delay notice, or a spam-complaint report. Returns null when the message is
 * neither. `ownAddresses` (our mailboxes) are never treated as the failed recipient.
 */
export function parseDeliveryReport(message: ReportSource, ownAddresses: string[] = [], options: { assumeReport?: boolean } = {}): DeliveryReport | null {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const isOwn = (e: string) => own.has(e);
  const subject = message.subject ?? '';
  const { originalMessageId, originalRecipients } = originalOf(message, own);
  const referencedIds = referencedOf(message, originalMessageId);

  if (isComplaintReport(message)) {
    const fr = message.report?.feedbackReport ?? '';
    const rcpt = addressField(fr.match(/^\s*original-rcpt-to:\s*([^\n]+)/im)?.[1]) ?? originalRecipients[0] ?? null;
    const diagnostic = clean(`Spam complaint (Feedback-Type: ${fr.match(/^\s*feedback-type:\s*([^\n]+)/im)?.[1]?.trim() ?? 'abuse'})${fr.match(/^\s*user-agent:\s*([^\n]+)/im)?.[1] ? ` from ${fr.match(/^\s*user-agent:\s*([^\n]+)/im)![1]!.trim()}` : ''}`);
    return {
      kind: 'COMPLAINT',
      failures: [{ email: rcpt && !isOwn(rcpt) ? rcpt : null, action: null, final: true, statusCode: null, diagnostic, category: 'COMPLAINT', remark: CATEGORY_REMARK.COMPLAINT }],
      referencedIds,
      originalMessageId,
      originalRecipients,
    };
  }

  if (!options.assumeReport && !isDeliveryReport(message)) return null;

  const fullText = textOf(message);
  const text = ownPart(fullText);
  const structured = [
    ...parseDeliveryStatus(message.report?.deliveryStatus ?? ''),
    ...(/final-recipient:/i.test(fullText) ? parseDeliveryStatus(fullText) : []),
  ].filter((r) => !isOwn(r.email) && !DAEMON.test(r.email));

  const failures: DeliveryFailure[] = [];
  const seen = new Set<string>();
  const globalStatus = statusFromText(text);
  const globalDiagnostic = diagnosticFromText(text, subject);

  for (const r of structured) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    // Prefer the human text's diagnostic when the report has none.
    const code = r.status ?? r.diagnostic?.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] ?? r.diagnostic?.match(/^([45]\d\d)\b/)?.[1] ?? globalStatus;
    failures.push(failure(r.email, r.action, code, r.diagnostic ?? globalDiagnostic, text, subject));
  }
  for (const email of recipientsFromText(text, message.headers, isOwn)) {
    if (seen.has(email)) continue;
    seen.add(email);
    failures.push(failure(email, null, globalStatus, globalDiagnostic, text, subject));
  }
  if (!failures.length) {
    // The notice doesn't name the address: one recipient in the original's headers, else the
    // matched send decides (lib/email/ndr.ts).
    const single = originalRecipients.length === 1 ? originalRecipients[0]! : null;
    failures.push(failure(single, null, globalStatus, globalDiagnostic, text, subject));
  }

  return { kind: 'BOUNCE', failures, referencedIds, originalMessageId, originalRecipients };
}

// ─────────────────────────── left the company ───────────────────────────

const LEFT_COMPANY = [
  /\b(?:is|am|are|has been|have been)\s+no longer\s+(?:with|at|working (?:with|at|for)|employed (?:with|at|by)|part of|associated with|a member of|an employee of|in (?:the|this) (?:company|organi[sz]ation))\b/i,
  /\bno longer (?:works?|working|employed) (?:with|at|for|here)\b/i,
  /\b(?:has|have) (?:now )?left (?:the|our|this) (?:company|organi[sz]ation|firm|business|group)\b/i,
  /\b(?:this|the|my) (?:mailbox|e-?mail (?:address|account|id)|inbox|account)\s+(?:is\s+|has been\s+)?(?:no longer|not)\s+(?:being\s+)?(?:monitored|active|in use|in service|valid|operational)\b/i,
  /\b(?:this|the) (?:mailbox|e-?mail (?:address|account|id)|account)\s+(?:has been|is|was)\s+(?:deactivated|discontinued|closed|disabled|retired)\b/i,
];

/** The reply part of a message (before the quoted original). */
function replyPart(text: string): string {
  const cut = text.search(/\n\s*(?:On .{5,200}?wrote:|-{2,}\s*Original Message|_{5,}|From:\s.+\n\s*(?:Sent|Date):)/i);
  return (cut > 0 ? text.slice(0, cut) : text).slice(0, 4000);
}

/** An automatic reply saying the person has left / the mailbox is no longer used: the phrase, or null. */
export function detectLeftCompany(message: { plainTextBody: string | null; htmlBody: string | null; subject?: string | null }): string | null {
  const text = `${message.subject ?? ''}\n${replyPart(textOf(message))}`;
  for (const re of LEFT_COMPANY) {
    const m = text.match(re);
    if (m) {
      // The sentence around the match, as the "server's words".
      const start = Math.max(0, text.lastIndexOf('\n', m.index ?? 0) + 1);
      const endNl = text.indexOf('\n', (m.index ?? 0) + m[0].length);
      return clean(text.slice(start, endNl === -1 ? undefined : endNl), 300);
    }
  }
  return null;
}

/** A DeliveryReport for a left-the-company auto-reply from `email`. */
export function leftCompanyReport(email: string, phrase: string, message: { inReplyTo?: string | null; references?: string | null }): DeliveryReport {
  return {
    kind: 'LEFT_COMPANY',
    failures: [{ email: email.toLowerCase(), action: null, final: true, statusCode: null, diagnostic: phrase, category: 'LEFT_COMPANY', remark: CATEGORY_REMARK.LEFT_COMPANY }],
    referencedIds: [...new Set([...idsIn(message.inReplyTo), ...idsIn(message.references)])],
    originalMessageId: null,
    originalRecipients: [],
  };
}

/** "Bounced: Address doesn't exist (5.1.1)" — the send page's reason. */
export function bounceSkipReason(f: Pick<DeliveryFailure, 'category' | 'remark' | 'statusCode'>): string {
  const prefix = f.category === 'LEFT_COMPANY' ? 'Left company' : f.category === 'COMPLAINT' ? 'Spam complaint' : 'Bounced';
  return `${prefix}: ${f.remark}${f.statusCode ? ` (${f.statusCode})` : ''}`.slice(0, 300);
}
