import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildMimeMessage } from '@/lib/email/mime';

/**
 * §22 sender/recipient settings.
 *
 * The parsing rule is duplicated from the campaign PATCH route so the
 * accepted/rejected shapes are pinned independently of the handler.
 */
const emailListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(/[,;\n]/)).map((e) => e.trim()).filter(Boolean)
  )
  .refine((list) => list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)), {
    message: 'One or more addresses are not valid email addresses.',
  })
  .refine((list) => list.length <= 25, { message: 'At most 25 addresses.' });

describe('CC/BCC list parsing', () => {
  it('splits a comma-separated string', () => {
    expect(emailListSchema.parse('a@x.test, b@x.test')).toEqual(['a@x.test', 'b@x.test']);
  });

  it('accepts semicolons and newlines, which is how people paste lists', () => {
    expect(emailListSchema.parse('a@x.test; b@x.test\nc@x.test')).toEqual([
      'a@x.test',
      'b@x.test',
      'c@x.test',
    ]);
  });

  it('trims whitespace and drops empty entries from trailing separators', () => {
    expect(emailListSchema.parse('  a@x.test ,, b@x.test , ')).toEqual(['a@x.test', 'b@x.test']);
  });

  it('accepts an empty string as an empty list (clearing the field)', () => {
    expect(emailListSchema.parse('')).toEqual([]);
  });

  it('accepts an array as well as a string', () => {
    expect(emailListSchema.parse(['a@x.test'])).toEqual(['a@x.test']);
  });

  it('rejects a malformed address rather than silently dropping it', () => {
    expect(() => emailListSchema.parse('a@x.test, not-an-email')).toThrow();
  });

  it('rejects an unreasonably long list', () => {
    const many = Array.from({ length: 26 }, (_, i) => `u${i}@x.test`).join(',');
    expect(() => emailListSchema.parse(many)).toThrow();
  });
});

describe('CC/BCC delivery volume', () => {
  // The number people get wrong: cc/bcc are per-message, not per-campaign.
  const totalDeliveries = (recipients: number, cc: number, bcc: number) =>
    recipients * (1 + cc + bcc);

  it('counts one delivery per recipient with no cc/bcc', () => {
    expect(totalDeliveries(250, 0, 0)).toBe(250);
  });

  it('multiplies by every cc/bcc address', () => {
    expect(totalDeliveries(250, 1, 0)).toBe(500);
    expect(totalDeliveries(250, 1, 1)).toBe(750);
  });

  it('makes the blow-up on a large campaign obvious', () => {
    expect(totalDeliveries(1000, 2, 1)).toBe(4000);
  });
});

describe('headers actually reach the message', () => {
  const base = {
    to: 'student@example.com',
    fromName: 'Placement Team',
    fromEmail: 'abhishesh@masaischool.com',
    subject: 'Reminder',
    html: '<p>Hi</p>',
  };

  it('renders From with the configured display name', () => {
    const { raw } = buildMimeMessage(base);
    expect(raw).toContain('From: "Placement Team" <abhishesh@masaischool.com>');
  });

  it('renders Reply-To when set', () => {
    const { raw } = buildMimeMessage({ ...base, replyTo: 'placement@masaischool.com' });
    expect(raw).toContain('Reply-To: placement@masaischool.com');
  });

  it('renders Cc and Bcc lists', () => {
    const { raw } = buildMimeMessage({
      ...base,
      cc: ['lead@masaischool.com', 'ops@masaischool.com'],
      bcc: ['archive@masaischool.com'],
    });
    expect(raw).toContain('Cc: lead@masaischool.com, ops@masaischool.com');
    expect(raw).toContain('Bcc: archive@masaischool.com');
  });

  it('omits the headers entirely when unset, rather than sending empty ones', () => {
    const { raw } = buildMimeMessage(base);
    const headers = raw.split('\r\n\r\n')[0] ?? '';
    expect(headers).not.toMatch(/^Cc:/m);
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).not.toMatch(/^Reply-To:/m);
  });
});
