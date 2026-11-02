import { prisma } from '@/lib/db/client';
import { dispatchWebhook } from '@/lib/webhooks/dispatch';

/**
 * Bounce notices. With Gmail most bounces don't fail the send: Gmail accepts the message and a
 * "Delivery Status Notification" arrives in the same thread minutes later. Those notices are
 * read here so the dead address is suppressed and never mailed again (protecting the sender
 * reputation Google judges every mailbox by). Only permanent failures suppress; "mailbox full"
 * and other temporary problems don't.
 */

export interface BounceInfo {
  /** Addresses the notice says could not be delivered to (lower-cased). */
  recipients: string[];
  /** True for a permanent failure (5.x.x, "address not found"), false for temporary ones. */
  permanent: boolean;
  /** Short human-readable reason, for the suppression list. */
  detail: string;
}

const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Phrases that introduce the failed address in the common notice formats (Gmail, Outlook /
// Exchange, Postfix, Exim, Yahoo) and the machine-readable delivery-status part.
const RECIPIENT_PATTERNS = [
  /x-failed-recipients:\s*([^\n]+)/i,
  /final-recipient:\s*rfc822;\s*([^\s;]+)/gi,
  /original-recipient:\s*rfc822;\s*([^\s;]+)/gi,
  /(?:wasn['’]?t|was not|couldn['’]?t be|could not be) delivered to\s+([^\s<>()"]+@[^\s<>()",;]+)/gi,
  /delivery to the following recipients? (?:failed|has failed)[^\n]*\n+\s*([^\s<>()"]+@[^\s<>()",;]+)/gi,
  /<([^<>\s]+@[^<>\s]+)>:?\s*(?:\n|\s)*(?:host|said|550|553|554|5\.\d)/gi,
  /(?:recipient|address)(?: address)? (?:rejected|not found|unknown)[:\s]+<?([^\s<>()"]+@[^\s<>()",;]+)/gi,
];

const PERMANENT = [
  /\b5\.[1-7]\.\d{1,3}\b/, // enhanced status 5.x.x
  /\b55[0-4]\b/, // SMTP permanent reply codes
  /address (?:couldn['’]?t be found|not found|does not exist|is unknown)/i,
  /(?:user|mailbox|recipient|account)(?: name)? (?:unknown|not found|does not exist|doesn['’]?t exist|unavailable|disabled|inactive)/i,
  /no such (?:user|mailbox|recipient|address)/i,
  /recipient address rejected/i,
  /domain (?:name )?not found|domain (?:does not|doesn['’]?t) exist|no mx record|unrouteable/i,
  /status:\s*5\.\d/i,
];

const TEMPORARY = [
  /\b4\.\d\.\d{1,3}\b/,
  /\b4[25][0-2]\b/,
  /mailbox (?:is )?full|over (?:its |the )?quota|quota exceeded|insufficient (?:system )?storage/i,
  /temporar(?:y|ily)|try again later|will (?:retry|keep trying)|delayed|deferred|greylist/i,
  /status:\s*4\.\d/i,
];

function textOf(message: { plainTextBody: string | null; htmlBody: string | null }): string {
  const fromHtml = (message.htmlBody ?? '')
    .replace(/<(?:br|\/p|\/div|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return `${message.plainTextBody ?? ''}\n${fromHtml}`;
}

/** Reads a bounce notice. `ownAddresses` (our mailboxes) are never treated as the failed recipient. */
export function parseBounce(
  message: { plainTextBody: string | null; htmlBody: string | null; headers?: Record<string, string>; subject?: string },
  ownAddresses: string[] = [],
): BounceInfo {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const text = `${message.headers?.['x-failed-recipients'] ? `X-Failed-Recipients: ${message.headers['x-failed-recipients']}\n` : ''}${textOf(message)}`;

  const found = new Set<string>();
  for (const pattern of RECIPIENT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of text.matchAll(re)) {
      for (const addr of (m[1] ?? '').match(EMAIL) ?? []) {
        const a = addr.toLowerCase().replace(/[.)>,;:]+$/, '');
        if (!own.has(a) && !/^(mailer-daemon|postmaster)@/i.test(a)) found.add(a);
      }
    }
  }

  const sample = `${message.subject ?? ''}\n${text}`;
  const temporary = TEMPORARY.some((r) => r.test(sample));
  const permanent = PERMANENT.some((r) => r.test(sample)) && !(temporary && !/\b5\.[1-7]\.\d|\b55[0-4]\b/.test(sample));

  const reason =
    sample.match(/(?:\b[45]\.\d\.\d{1,3}\b[^\n]{0,120})/)?.[0] ??
    sample.match(/(?:address (?:couldn['’]?t be found|not found)|mailbox (?:is )?full|no such user|user unknown)[^\n]{0,100}/i)?.[0] ??
    'Delivery failed';

  return { recipients: [...found], permanent, detail: reason.replace(/\s+/g, ' ').trim().slice(0, 300) };
}

/**
 * Suppresses the addresses a permanent bounce names. When the notice doesn't say which
 * address failed (some servers don't), the conversation's own recipient is used — the notice
 * is in that conversation's thread, so it is about the email sent to them.
 * Returns the suppressed addresses.
 */
export async function suppressBounced(input: {
  workspaceId: string;
  conversationRecipient: string | null;
  message: { plainTextBody: string | null; htmlBody: string | null; headers?: Record<string, string>; subject?: string };
  ownAddresses: string[];
}): Promise<string[]> {
  const info = parseBounce(input.message, input.ownAddresses);
  if (!info.permanent) return [];
  const own = new Set(input.ownAddresses.map((a) => a.toLowerCase()));
  const fallback = input.conversationRecipient?.toLowerCase();
  const usableFallback = fallback && !own.has(fallback) && !/^(mailer-daemon|postmaster|mail-daemon)@/i.test(fallback) ? fallback : null;
  const addresses = info.recipients.length ? info.recipients : usableFallback ? [usableFallback] : [];

  for (const email of addresses) {
    const lastJob = await prisma.emailJob.findFirst({
      where: { toEmail: { equals: email, mode: 'insensitive' }, campaign: { workspaceId: input.workspaceId } },
      orderBy: { createdAt: 'desc' },
      select: { campaignId: true },
    });
    const detail = `Bounce notice: ${info.detail}`;
    await prisma.emailSuppression.upsert({
      where: { workspaceId_email: { workspaceId: input.workspaceId, email } },
      create: { workspaceId: input.workspaceId, email, source: 'BOUNCE', reason: 'BOUNCED', detail, campaignId: lastJob?.campaignId ?? undefined },
      // An unsubscribe or a manual entry stays as it is; only bounce entries are refreshed.
      update: {},
    });
    await prisma.record.updateMany({
      where: { contact: { primaryEmail: { equals: email, mode: 'insensitive' }, workspaceId: input.workspaceId } },
      data: { emailStatus: 'BOUNCED', lastEmailError: detail.slice(0, 500) },
    });
    dispatchWebhook(input.workspaceId, 'email.bounced', { email, reason: 'BOUNCED', detail, campaignId: lastJob?.campaignId ?? null }).catch(() => undefined);
  }
  return addresses;
}
