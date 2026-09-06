import type {
  CampaignDigestInput,
  ContextMessage,
  ConversationContext,
  GenerateEmailInput,
  ImproveTextInput,
  PersonalizationCheckInput,
  ReplyStyle,
  SubjectLinesInput,
} from '@/lib/ai/types';

/**
 * Prompt construction and §81 context minimisation. Pure functions so the
 * exact text sent to the provider is unit-testable — in particular that
 * quoted reply tails, signatures, email addresses and phone numbers are
 * stripped before anything leaves the app.
 */

export const SYSTEM_BASE = [
  'You are the writing assistant inside MailFlow, an internal email tool used by the Masai School team',
  '(placements, admissions, operations) to communicate with students.',
  'Rules:',
  '- Write in clear, warm, professional Indian English. No hype, no emojis unless asked.',
  '- Template variables look like {{Name}} or {{Deadline}}. Keep every variable EXACTLY as written; never invent new ones.',
  '- Never invent facts, dates, amounts, links or policies that are not in the input.',
  '- Never include placeholders like [insert X]; if something is unknown, leave it out or use a variable that exists.',
  '- You never send anything. A human reviews everything you write.',
  '- Respond ONLY with the JSON requested.',
].join('\n');

// ── §81 minimisation helpers ──────────────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(\+?\d[\d\s().-]{8,}\d)/g;
const QUOTE_HEADER_RE = /^(On .{5,200} wrote:|From: .+|-{2,} ?(Original|Forwarded) message ?-{2,}|_{5,}|Sent from my .+)$/im;

/** Drops quoted history and signatures, collapses whitespace. */
export function stripQuotedTail(text: string): string {
  let body = text.replace(/\r\n/g, '\n');
  const m = QUOTE_HEADER_RE.exec(body);
  if (m && m.index > 0) body = body.slice(0, m.index);
  body = body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');
  // Signature delimiter per RFC 3676.
  const sig = body.indexOf('\n-- \n');
  if (sig > 0) body = body.slice(0, sig);
  return body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Replaces addresses and phone numbers — the model needs neither to write a reply. */
export function redact(text: string): string {
  return text.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()} […]`;
}

export function firstName(name: string | null | undefined, fallback = 'there'): string {
  const n = (name ?? '').trim();
  if (!n) return fallback;
  return n.split(/\s+/)[0] ?? fallback;
}

export interface RawMessage {
  direction: 'INBOUND' | 'OUTBOUND';
  at: Date | string | null | undefined;
  plainText?: string | null;
  html?: string | null;
  snippet?: string | null;
}

const TAG_RE = /<[^>]+>/g;
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(TAG_RE, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * The minimum context a model needs to summarise or reply: the last
 * `maxMessages` turns, each stripped, redacted and capped. Oldest first.
 */
export function minimiseConversation(
  messages: RawMessage[],
  opts: { maxMessages?: number; maxCharsPerMessage?: number } = {}
): ContextMessage[] {
  const maxMessages = opts.maxMessages ?? 8;
  const maxChars = opts.maxCharsPerMessage ?? 1500;
  const ordered = [...messages].sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());
  return ordered.slice(-maxMessages).map((m) => {
    const raw = m.plainText?.trim() || (m.html ? htmlToText(m.html) : '') || m.snippet || '';
    return {
      from: m.direction === 'INBOUND' ? 'student' : 'team',
      at: m.at ? new Date(m.at).toISOString() : '',
      text: truncate(redact(stripQuotedTail(raw)), maxChars),
    };
  });
}

function transcript(ctx: ConversationContext): string {
  const lines = ctx.messages.map((m) => `[${m.from === 'student' ? ctx.recipientFirstName : ctx.senderName} · ${m.at.slice(0, 10)}]\n${m.text}`);
  return `Subject: ${ctx.subject}\n\n${lines.join('\n\n')}`;
}

// ── prompts ───────────────────────────────────────────────────────────────

export function generateEmailPrompt(input: GenerateEmailInput): string {
  const vars = input.variables.length ? input.variables.map((v) => `{{${v}}}`).join(', ') : '(none)';
  return [
    `Write an email for this brief: "${input.brief.trim()}"`,
    `Tone: ${input.tone ?? 'professional'}.`,
    `Sender: ${input.senderName ?? 'the Masai team'}${input.orgName ? ` at ${input.orgName}` : ''}.`,
    `Available variables (use only these, exactly as written): ${vars}.`,
    'Produce: a subject line, a one-sentence preview text, the plain-text body, and the same body as simple, inline-styled HTML',
    '(use <p>, <strong>, <a>, <ul>/<li> only; no <html>/<body> wrapper, no images, no external CSS).',
    'Return usedVariables: the variables you actually used.',
  ].join('\n');
}

const MODE_INSTRUCTIONS: Record<ImproveTextInput['mode'], string> = {
  improve: 'Improve clarity and flow while keeping the meaning, length and structure.',
  shorten: 'Make it noticeably shorter (aim for about half) without losing any required information or call to action.',
  professional: 'Make it more professional and polished; keep it warm, not stiff.',
  friendly: 'Make it friendlier and more conversational while staying respectful.',
  formal: 'Make it more formal and precise.',
  rewrite: 'Rewrite it from scratch with the same intent and information, in a fresh way.',
  grammar: 'Fix grammar, spelling and punctuation only. Change nothing else.',
  translate: 'Translate it faithfully into the target language; keep names, links and variables unchanged.',
  cta: 'Add or sharpen a single clear call to action near the end; keep everything else.',
};

export function improveTextPrompt(input: ImproveTextInput): string {
  const vars = input.variables.length ? input.variables.map((v) => `{{${v}}}`).join(', ') : '(none)';
  return [
    `Task: ${MODE_INSTRUCTIONS[input.mode]}${input.mode === 'translate' ? ` Target language: ${input.language ?? 'Hindi'}.` : ''}`,
    `Format: ${input.format === 'html' ? 'HTML — return valid HTML using the same tags as the input' : 'plain text'}.`,
    `Variables to preserve verbatim: ${vars}.`,
    'Return the rewritten text and a short list of what you changed.',
    '',
    '--- INPUT START ---',
    input.text,
    '--- INPUT END ---',
  ].join('\n');
}

export function subjectLinesPrompt(input: SubjectLinesInput): string {
  const vars = input.variables.length ? input.variables.map((v) => `{{${v}}}`).join(', ') : '(none)';
  return [
    `Write ${input.count ?? 5} subject lines for this email. Brief: "${input.brief.trim()}".`,
    input.body ? `Body (for context):\n${truncate(input.body, 1500)}` : '',
    `Variables you may use: ${vars}.`,
    'Each under 60 characters, specific, no clickbait, no ALL CAPS, at most one with a variable.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function personalizationPrompt(input: PersonalizationCheckInput): string {
  return [
    'Review this email template for personalisation quality.',
    `Available dataset variables: ${input.availableVariables.map((v) => `{{${v}}}`).join(', ') || '(none)'}.`,
    `Variables the template currently uses: ${input.usedVariables.map((v) => `{{${v}}}`).join(', ') || '(none)'}.`,
    'Report: a 0–100 score, concrete findings (e.g. generic greeting, missed opportunity to use {{Deadline}}, tone mismatch),',
    'and specific suggestions. Do not rewrite the email.',
    '',
    `Subject: ${input.subject}`,
    '--- BODY START ---',
    truncate(input.body, 4000),
    '--- BODY END ---',
  ].join('\n');
}

export function summarizePrompt(ctx: ConversationContext): string {
  return [
    `Summarise this email conversation between the Masai team (${ctx.senderName}) and a student (${ctx.recipientFirstName}) in 1–3 sentences.`,
    'Then suggest ONE next action for the team member, and the conversation status that would fit',
    '(OPEN, IN_PROGRESS, WAITING_FOR_STUDENT, RESOLVED) or null if unsure. The human decides; you only suggest.',
    '',
    transcript(ctx),
  ].join('\n');
}

export function classifyPrompt(ctx: ConversationContext): string {
  const last = ctx.messages.filter((m) => m.from === 'student').at(-1);
  return [
    "Classify the student's LATEST message in this conversation with exactly one intent:",
    'COMPLETED (they did the thing asked), QUESTION, REQUEST (asking for something), COMPLAINT, ACKNOWLEDGEMENT (simple thanks/ok),',
    'NEEDS_ACTION (the team must do something), OUT_OF_OFFICE, AUTO_REPLY (machine-generated), UNKNOWN.',
    'Give a confidence from 0 to 1 and a one-line reason.',
    '',
    transcript(ctx),
    '',
    `Latest student message to classify:\n${last?.text ?? '(none)'}`,
  ].join('\n');
}

const STYLE_INSTRUCTIONS: Record<ReplyStyle, string> = {
  default: 'Keep it concise (3–6 sentences).',
  shorter: 'Keep it very short (1–3 sentences).',
  formal: 'Use a formal register; keep it concise.',
};

export function suggestReplyPrompt(ctx: ConversationContext, style: ReplyStyle = 'default'): string {
  return [
    `Draft a reply from ${ctx.senderName} (Masai team) to ${ctx.recipientFirstName} for the conversation below.`,
    STYLE_INSTRUCTIONS[style],
    `Start with "Hi ${ctx.recipientFirstName}," and end with "Regards,\n${ctx.senderName}".`,
    'Only commit to things the team has already said in the thread; otherwise say the team will follow up.',
    'Plain text only, no subject line.',
    '',
    transcript(ctx),
  ].join('\n');
}

export function campaignSummaryPrompt(input: CampaignDigestInput): string {
  return [
    `Summarise the outcome of email campaign "${input.name}" (status ${input.status}) for the person who ran it, in 2–4 sentences,`,
    'then list concrete next steps. Be specific about failures; do not speculate beyond the numbers given.',
    '',
    JSON.stringify(
      {
        total: input.total,
        sent: input.sent,
        failed: input.failed,
        skipped: input.skipped,
        pending: input.pending,
        replies: input.replies,
        topErrors: input.topErrors,
        topSkipReasons: input.topSkipReasons,
      },
      null,
      2
    ),
  ].join('\n');
}

export function explainPrompt(question: string, facts: Record<string, unknown>): string {
  return [
    question,
    'Explain in plain language for a non-technical team member using ONLY the facts below, then list next steps.',
    'If the facts do not answer the question, say what is missing instead of guessing.',
    '',
    JSON.stringify(facts, null, 2),
  ].join('\n');
}
