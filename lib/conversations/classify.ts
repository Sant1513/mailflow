import type { ParsedMessage } from '@/lib/gmail/parseMessage';

/**
 * §55/§80 inbound classification, header-first.
 *
 * Automated mail (bounces, out-of-office, list traffic) must never be
 * treated as a human reply: it would mark a student as "replied", clear a
 * follow-up, and stop an automation that should have kept going. The
 * signals here are the ones mail systems are required or conventional to
 * set, so they are cheap and reliable — the AI classifier (Phase 7) only
 * runs on what survives this pass.
 */
export type Classification =
  | 'HUMAN_REPLY'
  | 'OUT_OF_OFFICE'
  | 'BOUNCE'
  | 'DELIVERY_FAILURE'
  | 'AUTO_REPLY'
  | 'UNKNOWN';

export interface ClassificationResult {
  classification: Classification;
  confidence: number;
  reason: string;
}

const BOUNCE_SENDERS = /^(mailer-daemon|postmaster|mail-daemon|bounce|no-?reply-bounce)@/i;
const DELIVERY_SUBJECT = /(delivery (status )?(notification|failure)|undeliverable|returned mail|mail delivery (failed|subsystem)|failure notice|could not be delivered)/i;
const OOO_SUBJECT = /(out of (the )?office|auto(matic)?[- ]?reply|automatic response|away from (my )?(office|desk|email)|on (annual |vacation |sick )?leave|currently unavailable)/i;
const NOREPLY_SENDER = /^(no-?reply|do-?not-?reply|notifications?|noreply)[@.-]/i;

export function classifyInbound(message: Pick<ParsedMessage, 'headers' | 'from' | 'subject' | 'plainTextBody'>): ClassificationResult {
  const h = message.headers;
  const fromEmail = message.from?.email ?? '';
  const subject = message.subject ?? '';

  // RFC 3464/3834 machine signals — most reliable, checked first.
  const contentType = (h['content-type'] ?? '').toLowerCase();
  if (contentType.includes('multipart/report') && contentType.includes('delivery-status')) {
    return { classification: 'DELIVERY_FAILURE', confidence: 0.98, reason: 'multipart/report delivery-status' };
  }
  if (BOUNCE_SENDERS.test(fromEmail)) {
    return { classification: 'BOUNCE', confidence: 0.97, reason: `sender ${fromEmail}` };
  }
  if (DELIVERY_SUBJECT.test(subject)) {
    return { classification: 'DELIVERY_FAILURE', confidence: 0.9, reason: 'delivery-failure subject' };
  }

  const autoSubmitted = (h['auto-submitted'] ?? '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') {
    // auto-replied is the OOO convention; auto-generated is everything else.
    if (autoSubmitted.includes('auto-replied') || OOO_SUBJECT.test(subject)) {
      return { classification: 'OUT_OF_OFFICE', confidence: 0.95, reason: `Auto-Submitted: ${autoSubmitted}` };
    }
    return { classification: 'AUTO_REPLY', confidence: 0.92, reason: `Auto-Submitted: ${autoSubmitted}` };
  }
  if (h['x-autoreply'] || h['x-autorespond'] || (h['x-auto-response-suppress'] ?? '').toLowerCase().includes('oof')) {
    return { classification: 'OUT_OF_OFFICE', confidence: 0.9, reason: 'X-Autoreply / X-Auto-Response-Suppress' };
  }
  const precedence = (h['precedence'] ?? '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'list' || h['list-unsubscribe'] || h['list-id']) {
    return { classification: 'AUTO_REPLY', confidence: 0.85, reason: `Precedence/List headers (${precedence || 'list'})` };
  }
  if (OOO_SUBJECT.test(subject)) {
    return { classification: 'OUT_OF_OFFICE', confidence: 0.8, reason: 'out-of-office subject' };
  }
  if (NOREPLY_SENDER.test(fromEmail)) {
    return { classification: 'AUTO_REPLY', confidence: 0.75, reason: `no-reply sender ${fromEmail}` };
  }

  if (!fromEmail) {
    return { classification: 'UNKNOWN', confidence: 0.3, reason: 'no sender address' };
  }

  // Nothing automated about it: treat as a person until AI says otherwise.
  return { classification: 'HUMAN_REPLY', confidence: 0.7, reason: 'no automation signals' };
}

/** Whether this message should count as "the student replied" (§52). */
export function countsAsReply(classification: Classification): boolean {
  return classification === 'HUMAN_REPLY';
}
