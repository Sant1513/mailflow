import { z } from 'zod';

/**
 * RSVP buttons in campaign emails ("Will you attend? ✅ Yes / ❌ No"). Settings live on the
 * campaign (Campaign.rsvp); answers in RsvpResponse. Every visual and behavioural choice is a
 * setting, with sensible defaults, so the same feature fits a placement drive, an interview
 * slot or a webinar.
 *
 * Placement in the email: wherever the author put [[rsvp]] (or <div data-mailflow-rsvp></div>);
 * otherwise just before the unsubscribe footer.
 */

const HEX = /^#[0-9a-f]{6}$/i;
const hex = z.string().regex(HEX, 'Use a colour like #16a34a');

export const rsvpOptionSchema = z.object({
  /** Stable id used in links and stored answers. Never change it after sending. */
  key: z.string().regex(/^[a-z0-9_-]{1,24}$/),
  label: z.string().trim().min(1).max(40),
  emoji: z.string().max(8).default(''),
  background: hex,
  textColor: hex,
  /** Seat limit for this answer (e.g. 120 for "Yes"); null = unlimited. */
  capacity: z.number().int().positive().max(100_000).nullable().default(null),
  /** Shown after answering. */
  confirmTitle: z.string().trim().max(120),
  confirmMessage: z.string().trim().max(1000),
  /** Ask for an optional note after this answer (e.g. "why can't you make it?"). */
  askNote: z.boolean().default(false),
  notePrompt: z.string().trim().max(200).default(''),
});

export const rsvpConfigSchema = z.object({
  enabled: z.boolean(),
  question: z.string().trim().max(300),
  questionColor: hex,
  options: z.array(rsvpOptionSchema).min(1).max(4),
  shape: z.enum(['rounded', 'pill', 'square']),
  size: z.enum(['small', 'medium', 'large']),
  align: z.enum(['left', 'center']),
  layout: z.enum(['row', 'stacked']),
  /** After this time answers are closed (ISO); null = always open. */
  deadline: z.string().datetime({ offset: true }).nullable(),
  closedMessage: z.string().trim().max(500),
  /** When a seat limit is reached. */
  fullMessage: z.string().trim().max(500),
  allowChange: z.boolean(),
  /** Data column (key) the answer label is written to on the recipient's row; null = don't. */
  saveToColumn: z.string().max(100).nullable(),
  /** Notify the campaign owner in MailFlow on each answer. */
  notifyOwner: z.boolean(),
  /** Small text under the buttons (e.g. "Reply to this email if you have questions"). */
  footnote: z.string().trim().max(300),
});

export type RsvpOption = z.infer<typeof rsvpOptionSchema>;
export type RsvpConfig = z.infer<typeof rsvpConfigSchema>;

export function defaultRsvpConfig(): RsvpConfig {
  return {
    enabled: true,
    question: 'Will you attend?',
    questionColor: '#111827',
    options: [
      {
        key: 'yes', label: "Yes, I'll attend", emoji: '✅', background: '#16a34a', textColor: '#ffffff', capacity: null,
        confirmTitle: 'Thanks — see you there!', confirmMessage: "We've noted that you'll attend. You'll get the details by email.",
        askNote: false, notePrompt: '',
      },
      {
        key: 'no', label: "Can't make it", emoji: '❌', background: '#dc2626', textColor: '#ffffff', capacity: null,
        confirmTitle: 'Thanks for letting us know', confirmMessage: "We've noted that you can't attend.",
        askNote: true, notePrompt: 'Anything we should know? (optional)',
      },
    ],
    shape: 'rounded',
    size: 'medium',
    align: 'left',
    layout: 'row',
    deadline: null,
    closedMessage: 'Responses are closed for this one. Reply to the email if you need help.',
    fullMessage: 'Sorry, all seats for this option are taken. Reply to the email and we will help.',
    allowChange: true,
    saveToColumn: null,
    notifyOwner: false,
    footnote: '',
  };
}

/** The stored value, validated; null when RSVP is off or the stored value is unusable. */
export function readRsvpConfig(value: unknown): RsvpConfig | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = rsvpConfigSchema.safeParse(value);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}

export function isClosed(config: RsvpConfig, now = new Date()): boolean {
  return !!config.deadline && new Date(config.deadline).getTime() <= now.getTime();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SIZES = { small: { pad: '8px 14px', font: 13 }, medium: { pad: '11px 20px', font: 15 }, large: { pad: '14px 28px', font: 17 } } as const;
const RADIUS = { rounded: '6px', pill: '999px', square: '0' } as const;

/**
 * The buttons as email-safe HTML: tables and inline styles only (works in Gmail, Outlook,
 * Apple Mail). `linkFor(optionKey)` gives each button's URL.
 */
export function renderRsvpBlock(config: RsvpConfig, linkFor: (key: string) => string): string {
  const size = SIZES[config.size];
  const radius = RADIUS[config.shape];
  const align = config.align === 'center' ? 'center' : 'left';
  const button = (o: RsvpOption) => {
    const text = `${o.emoji ? `${esc(o.emoji)}&nbsp;` : ''}${esc(o.label)}`;
    return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;display:inline-table;margin:0 8px 8px 0;"><tr><td align="center" bgcolor="${o.background}" style="background:${o.background};border-radius:${radius};mso-padding-alt:${size.pad};"><a href="${esc(linkFor(o.key))}" data-mailflow-rsvp-link="1" target="_blank" style="display:inline-block;padding:${size.pad};font-family:Arial,Helvetica,sans-serif;font-size:${size.font}px;font-weight:bold;line-height:1.2;color:${o.textColor};text-decoration:none;border-radius:${radius};">${text}</a></td></tr></table>`;
  };
  const buttons =
    config.layout === 'stacked'
      ? config.options.map((o) => `<div style="margin:0;">${button(o)}</div>`).join('')
      : config.options.map(button).join('');
  const question = config.question
    ? `<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:${config.questionColor};">${esc(config.question)}</p>`
    : '';
  const footnote = config.footnote
    ? `<p style="margin:4px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280;">${esc(config.footnote)}</p>`
    : '';
  return `<div data-mailflow-rsvp-block="1" style="margin:20px 0;text-align:${align};">${question}${buttons}${footnote}</div>`;
}

const PLACEHOLDER = /\[\[\s*rsvp\s*\]\]|<div[^>]*data-mailflow-rsvp(?:=["'][^"']*["'])?[^>]*>\s*<\/div>/i;

/** Puts the block where the author placed [[rsvp]], else before </body> (or at the end). */
export function placeRsvpBlock(html: string, block: string): string {
  if (PLACEHOLDER.test(html)) return html.replace(PLACEHOLDER, block);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : `${html}${block}`;
}

/** Removes a stray placeholder (RSVP turned off but [[rsvp]] still in the template). */
export function stripRsvpPlaceholder(html: string): string {
  return html.replace(PLACEHOLDER, '');
}

/** Plain-text version for the text/plain part. */
export function renderRsvpText(config: RsvpConfig, linkFor: (key: string) => string): string {
  const lines = config.options.map((o) => `${o.emoji ? `${o.emoji} ` : ''}${o.label}: ${linkFor(o.key)}`);
  return `\n\n${config.question}\n${lines.join('\n')}${config.footnote ? `\n${config.footnote}` : ''}\n`;
}
