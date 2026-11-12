import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GmailMessage, GmailPart } from '@/lib/gmail/parseMessage';

/**
 * Test helper: turns a raw RFC 822 message (an .eml fixture) into the shape the Gmail API
 * returns for users.messages.get(format=full) — headers, mimeType, nested parts, base64url
 * bodies, and an attached message/rfc822 as a child part carrying the original's headers — so
 * fixtures go through the real parseGmailMessage.
 */

function splitHeadBody(raw: string): { head: string; body: string } {
  const i = raw.search(/\n\n/);
  return i === -1 ? { head: raw, body: '' } : { head: raw.slice(0, i), body: raw.slice(i + 2) };
}

function headers(head: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]!.value += ` ${line.trim()}`;
    else {
      const m = line.match(/^([^:\s]+):\s*(.*)$/);
      if (m) out.push({ name: m[1]!, value: m[2]! });
    }
  }
  return out;
}

function param(value: string, name: string): string | null {
  const m = value.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function decodeQP(s: string): Buffer {
  const bytes: number[] = [];
  const text = s.replace(/=\n/g, '');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(text[i]!, 'utf8'));
  }
  return Buffer.from(bytes);
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function part(raw: string): GmailPart {
  const { head, body } = splitHeadBody(raw);
  const hs = headers(head);
  const get = (n: string) => hs.find((h) => h.name.toLowerCase() === n)?.value ?? '';
  const ct = get('content-type') || 'text/plain';
  const mimeType = ct.split(';')[0]!.trim().toLowerCase();
  const filename = param(get('content-disposition'), 'filename') ?? param(ct, 'name') ?? '';
  if (mimeType.startsWith('multipart/')) {
    const boundary = param(ct, 'boundary')!;
    const chunks = body.split(`--${boundary}`).slice(1);
    const parts = chunks.filter((c) => !c.startsWith('--')).map((c) => part(c.replace(/^\n/, '').replace(/\n$/, '')));
    return { mimeType, filename: '', headers: hs, body: { size: 0 }, parts };
  }
  if (mimeType === 'message/rfc822') {
    return { mimeType, filename, headers: hs, body: { size: body.length }, parts: [part(body)] };
  }
  const enc = get('content-transfer-encoding').toLowerCase();
  const buf = enc === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? decodeQP(body) : Buffer.from(body, 'utf8');
  return { mimeType, filename, headers: hs, body: { size: buf.length, data: b64url(buf) } };
}

export function rawToGmail(raw: string, opts: { id?: string; threadId?: string; labelIds?: string[]; internalDate?: string } = {}): GmailMessage {
  const payload = part(raw.replace(/\r\n?/g, '\n'));
  return {
    id: opts.id ?? 'gm-1',
    threadId: opts.threadId ?? 'th-1',
    labelIds: opts.labelIds ?? ['INBOX'],
    snippet: '',
    internalDate: opts.internalDate ?? String(Date.parse('2026-11-12T08:00:00Z')),
    payload,
  };
}

export function fixture(name: string): string {
  return readFileSync(join(__dirname, name), 'utf8');
}
