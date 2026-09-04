import { describe, it, expect } from 'vitest';
import {
  buildMimeMessage,
  encodeHeaderValue,
  formatAddress,
  sanitizeHeaderValue,
  buildReferences,
  toGmailRaw,
  generateMessageId,
} from '@/lib/email/mime';

const base = {
  to: 'rahul@example.com',
  fromName: 'Abhishesh Kumar',
  fromEmail: 'abhishesh@masaischool.com',
  subject: 'RPG Clearance',
  html: '<p>Hello</p>',
};

function headersOf(raw: string): string {
  return raw.split('\r\n\r\n')[0] ?? '';
}

describe('buildMimeMessage — headers', () => {
  it('includes From with a quoted display name, To, Subject and Message-ID', () => {
    const { raw, messageIdHeader } = buildMimeMessage(base);
    const headers = headersOf(raw);
    expect(headers).toContain('From: "Abhishesh Kumar" <abhishesh@masaischool.com>');
    expect(headers).toContain('To: rahul@example.com');
    expect(headers).toContain('Subject: RPG Clearance');
    expect(headers).toContain(`Message-ID: ${messageIdHeader}`);
    expect(messageIdHeader).toMatch(/^<.+@masaischool\.com>$/);
  });

  it('includes Cc, Bcc and Reply-To when supplied', () => {
    const { raw } = buildMimeMessage({
      ...base,
      cc: ['a@x.test', 'b@x.test'],
      bcc: ['c@x.test'],
      replyTo: 'placement@masaischool.com',
    });
    const headers = headersOf(raw);
    expect(headers).toContain('Cc: a@x.test, b@x.test');
    expect(headers).toContain('Bcc: c@x.test');
    expect(headers).toContain('Reply-To: placement@masaischool.com');
  });

  it('omits Cc/Bcc/Reply-To entirely when not supplied', () => {
    const headers = headersOf(buildMimeMessage(base).raw);
    expect(headers).not.toContain('Cc:');
    expect(headers).not.toContain('Bcc:');
    expect(headers).not.toContain('Reply-To:');
  });
});

describe('buildMimeMessage — threading (§46)', () => {
  it('omits In-Reply-To/References for a new thread', () => {
    const headers = headersOf(buildMimeMessage(base).raw);
    expect(headers).not.toContain('In-Reply-To:');
    expect(headers).not.toContain('References:');
  });

  it('includes In-Reply-To and References when replying', () => {
    const parent = '<parent-id@masaischool.com>';
    const headers = headersOf(
      buildMimeMessage({ ...base, inReplyTo: parent, references: parent }).raw
    );
    expect(headers).toContain(`In-Reply-To: ${parent}`);
    expect(headers).toContain(`References: ${parent}`);
  });

  it('generates a unique Message-ID per message', () => {
    const a = buildMimeMessage(base).messageIdHeader;
    const b = buildMimeMessage(base).messageIdHeader;
    expect(a).not.toBe(b);
  });
});

describe('header injection safety', () => {
  it('strips CRLF from the subject so extra headers cannot be injected', () => {
    const { raw } = buildMimeMessage({
      ...base,
      subject: 'Hello\r\nBcc: attacker@evil.test',
    });
    const headers = headersOf(raw);
    // The payload must not become its own header line. It survives only as
    // part of the Subject value, which is inert.
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).toContain('Subject: Hello Bcc: attacker@evil.test');
  });

  it('strips CRLF from the sender display name', () => {
    const { raw } = buildMimeMessage({ ...base, fromName: 'A\r\nBcc: evil@x.test' });
    expect(headersOf(raw)).not.toMatch(/^Bcc:/m);
  });

  it('strips CRLF from the recipient address', () => {
    const { raw } = buildMimeMessage({ ...base, to: 'a@x.test\r\nBcc: evil@x.test' });
    expect(headersOf(raw)).not.toMatch(/^Bcc:/m);
  });

  it('sanitizeHeaderValue collapses newlines', () => {
    expect(sanitizeHeaderValue('a\r\nb\nc')).toBe('a b c');
  });
});

describe('encoding', () => {
  it('leaves plain ASCII headers untouched', () => {
    expect(encodeHeaderValue('Plain Subject')).toBe('Plain Subject');
  });

  it('RFC 2047 encodes non-ASCII subjects', () => {
    const encoded = encodeHeaderValue('Réunion 🎓');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    const b64 = encoded.slice('=?UTF-8?B?'.length, -2);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Réunion 🎓');
  });

  it('formats an address without a name as the bare address', () => {
    expect(formatAddress(undefined, 'a@x.test')).toBe('a@x.test');
    expect(formatAddress('   ', 'a@x.test')).toBe('a@x.test');
  });

  it('encodes non-ASCII display names', () => {
    expect(formatAddress('José', 'a@x.test')).toContain('=?UTF-8?B?');
  });
});

describe('body structure', () => {
  it('always includes both a text/plain and a text/html part', () => {
    const { raw } = buildMimeMessage(base);
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
  });

  it('derives a plain-text part from the HTML when none is given', () => {
    const { raw } = buildMimeMessage({ ...base, html: '<p>Hello <b>world</b></p>' });
    const parts = raw.split('Content-Transfer-Encoding: base64');
    const plainB64 = (parts[1] ?? '').split('\r\n').filter(Boolean)[0] ?? '';
    expect(Buffer.from(plainB64, 'base64').toString('utf8')).toContain('Hello world');
  });

  it('uses the supplied plain text when given', () => {
    const { raw } = buildMimeMessage({ ...base, plainText: 'Custom plain body' });
    expect(raw).toContain(Buffer.from('Custom plain body', 'utf8').toString('base64'));
  });

  it('wraps in multipart/mixed and includes the file when there are attachments', () => {
    const { raw } = buildMimeMessage({
      ...base,
      attachments: [{ filename: 'offer.pdf', mimeType: 'application/pdf', content: Buffer.from('PDFDATA') }],
    });
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('Content-Disposition: attachment; filename="offer.pdf"');
    expect(raw).toContain(Buffer.from('PDFDATA').toString('base64'));
  });

  it('does not use multipart/mixed when there are no attachments', () => {
    expect(buildMimeMessage(base).raw).not.toContain('multipart/mixed');
  });
});

describe('toGmailRaw', () => {
  it('produces unpadded base64url', () => {
    const encoded = toGmailRaw('a+b/c==test');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toMatch(/=$/);
  });

  it('round-trips back to the original message', () => {
    const message = buildMimeMessage(base).raw;
    const decoded = Buffer.from(toGmailRaw(message).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toBe(message);
  });
});

describe('buildReferences', () => {
  it('starts a chain from the first parent', () => {
    expect(buildReferences(null, '<a@x>')).toBe('<a@x>');
  });

  it('appends to an existing chain, oldest first', () => {
    expect(buildReferences('<a@x>', '<b@x>')).toBe('<a@x> <b@x>');
  });

  it('does not duplicate an id already in the chain', () => {
    expect(buildReferences('<a@x> <b@x>', '<b@x>')).toBe('<a@x> <b@x>');
  });

  it('returns null when there is nothing to reference', () => {
    expect(buildReferences(null, null)).toBeNull();
  });
});

describe('generateMessageId', () => {
  it('uses the sender domain', () => {
    expect(generateMessageId('a@masaischool.com')).toMatch(/@masaischool\.com>$/);
  });
});
