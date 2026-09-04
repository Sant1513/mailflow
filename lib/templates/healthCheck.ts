import { validateVariables } from './variables';

/**
 * §27 Email Health Check — the pre-flight run before a campaign can launch.
 * Every check is either `pass`, `warn`, or `fail`. A single `fail` blocks
 * the send (§33); warnings are surfaced but do not block.
 */
export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface HealthCheckItem {
  id: string;
  label: string;
  level: CheckLevel;
  detail?: string;
}

export interface HealthCheckInput {
  template: { subject: string; html: string; plainText?: string | null };
  /** Column keys available on the dataset this template will be sent against. */
  availableKeys?: string[];
  /** Whether a recipient (EMAIL-typed) column exists on the dataset. */
  hasRecipientColumn?: boolean;
  /** Whether the sending user has a connected, authorized email account. */
  senderConnected?: boolean;
  senderEmail?: string | null;
}

export interface HealthCheckResult {
  items: HealthCheckItem[];
  blocked: boolean;
  failCount: number;
  warnCount: number;
}

const SUSPICIOUS_LINK_RE = /href\s*=\s*["'](?!https?:|mailto:|tel:|\{\{)[^"']*["']/gi;
const IMG_SRC_RE = /<img[^>]+src\s*=\s*["']([^"']*)["']/gi;
const LINK_HREF_RE = /href\s*=\s*["']([^"']*)["']/gi;

export function runHealthCheck(input: HealthCheckInput): HealthCheckResult {
  const { template } = input;
  const items: HealthCheckItem[] = [];

  // Subject present
  items.push(
    template.subject.trim()
      ? { id: 'subject', label: 'Subject present', level: 'pass' }
      : { id: 'subject', label: 'Subject present', level: 'fail', detail: 'The subject line is empty.' }
  );

  // Body present
  items.push(
    template.html.trim()
      ? { id: 'body', label: 'Email body present', level: 'pass' }
      : { id: 'body', label: 'Email body present', level: 'fail', detail: 'The email body is empty.' }
  );

  // Variables resolve against the dataset
  if (input.availableKeys) {
    const validation = validateVariables(template, input.availableKeys);
    items.push(
      validation.ok
        ? { id: 'variables', label: 'All variables valid', level: 'pass', detail: validation.used.length ? `Uses: ${validation.used.join(', ')}` : 'No variables used.' }
        : {
            id: 'variables',
            label: 'All variables valid',
            level: 'fail',
            detail: `Template references ${validation.missing.map((m) => `{{${m}}}`).join(', ')}, which ${validation.missing.length === 1 ? 'does' : 'do'} not exist in this dataset.`,
          }
    );
  }

  // Recipient column
  if (input.hasRecipientColumn !== undefined) {
    items.push(
      input.hasRecipientColumn
        ? { id: 'recipient', label: 'Recipient column valid', level: 'pass' }
        : { id: 'recipient', label: 'Recipient column valid', level: 'fail', detail: 'This dataset has no email column to send to.' }
    );
  }

  // Sender connected + authorized
  if (input.senderConnected !== undefined) {
    items.push(
      input.senderConnected
        ? { id: 'sender', label: 'Sender connected', level: 'pass', detail: input.senderEmail ?? undefined }
        : { id: 'sender', label: 'Sender connected', level: 'fail', detail: 'Connect your Gmail account in Settings before sending.' }
    );
  }

  // Unbalanced/malformed variable braces — a common typo that would send
  // a literal "{{Name" to a student.
  const strayBraces = (template.html.match(/\{\{/g)?.length ?? 0) !== (template.html.match(/\}\}/g)?.length ?? 0);
  if (strayBraces) {
    items.push({ id: 'braces', label: 'Variable syntax well-formed', level: 'fail', detail: 'Unbalanced {{ }} braces in the body.' });
  } else {
    items.push({ id: 'braces', label: 'Variable syntax well-formed', level: 'pass' });
  }

  // Links
  const links = Array.from(template.html.matchAll(LINK_HREF_RE)).map((m) => m[1] ?? '');
  const emptyLinks = links.filter((h) => !h.trim() || h.trim() === '#');
  const suspicious = Array.from(template.html.matchAll(SUSPICIOUS_LINK_RE));
  if (links.length === 0) {
    items.push({ id: 'links', label: 'Links valid', level: 'pass', detail: 'No links in this email.' });
  } else if (emptyLinks.length > 0) {
    items.push({ id: 'links', label: 'Links valid', level: 'warn', detail: `${emptyLinks.length} link(s) point nowhere ("#" or empty).` });
  } else if (suspicious.length > 0) {
    items.push({ id: 'links', label: 'Links valid', level: 'warn', detail: 'Some links use an unusual scheme — check they are correct.' });
  } else {
    items.push({ id: 'links', label: 'Links valid', level: 'pass', detail: `${links.length} link(s) checked.` });
  }

  // Images
  const images = Array.from(template.html.matchAll(IMG_SRC_RE)).map((m) => m[1] ?? '');
  const brokenImages = images.filter((src) => !src.trim());
  if (brokenImages.length > 0) {
    items.push({ id: 'images', label: 'Images valid', level: 'warn', detail: `${brokenImages.length} image(s) have an empty src.` });
  } else if (images.some((src) => src.startsWith('http://'))) {
    items.push({ id: 'images', label: 'Images valid', level: 'warn', detail: 'Some images load over http:// and may be blocked by mail clients.' });
  } else if (images.length > 0) {
    items.push({ id: 'images', label: 'Images valid', level: 'pass', detail: `${images.length} image(s) checked.` });
  }

  // Plain-text alternative — improves deliverability
  if (!template.plainText?.trim()) {
    items.push({ id: 'plaintext', label: 'Plain-text alternative', level: 'warn', detail: 'No plain-text version — some clients and spam filters prefer one.' });
  } else {
    items.push({ id: 'plaintext', label: 'Plain-text alternative', level: 'pass' });
  }

  // Size — Gmail clips messages over ~102KB
  const sizeKb = Buffer.byteLength(template.html, 'utf8') / 1024;
  if (sizeKb > 102) {
    items.push({ id: 'size', label: 'Message size', level: 'warn', detail: `${sizeKb.toFixed(0)}KB — Gmail clips messages over ~102KB.` });
  } else {
    items.push({ id: 'size', label: 'Message size', level: 'pass', detail: `${sizeKb.toFixed(1)}KB` });
  }

  const failCount = items.filter((i) => i.level === 'fail').length;
  const warnCount = items.filter((i) => i.level === 'warn').length;
  return { items, blocked: failCount > 0, failCount, warnCount };
}
