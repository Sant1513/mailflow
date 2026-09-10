import { describe, it, expect } from 'vitest';
import {
  classifyPrompt,
  firstName,
  generateEmailPrompt,
  improveTextPrompt,
  minimiseConversation,
  redact,
  stripQuotedTail,
  suggestReplyPrompt,
  summarizePrompt,
  truncate,
} from '@/lib/ai/prompts';

describe('stripQuotedTail (§81)', () => {
  it('drops everything from an "On … wrote:" line onward', () => {
    const text = 'Thanks, done!\n\nOn Fri, 5 Sep 2026 at 10:00, Team <team@masaischool.com> wrote:\n> Please complete RPG\n> by Friday';
    expect(stripQuotedTail(text)).toBe('Thanks, done!');
  });

  it('drops ">"-quoted lines, Outlook "From:" blocks and signatures', () => {
    const text = 'Sure.\n> earlier line\nFrom: Someone\nSent: yesterday\nbody of quote';
    expect(stripQuotedTail(text)).toBe('Sure.');
    expect(stripQuotedTail('Hi\n-- \nRahul Kumar\n+91 99999 99999')).toBe('Hi');
    expect(stripQuotedTail('Ok\nSent from my iPhone')).toBe('Ok');
  });

  it('collapses runs of blank lines and CRLF', () => {
    expect(stripQuotedTail('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
  });
});

describe('redact (§81)', () => {
  it('replaces email addresses and phone numbers', () => {
    expect(redact('mail rahul.k+1@gmail.com or call +91 98765 43210 today')).toBe('mail [email] or call [phone] today');
  });

  it('leaves ordinary numbers alone', () => {
    expect(redact('batch 2026 has 263 records')).toBe('batch 2026 has 263 records');
  });
});

describe('truncate / firstName', () => {
  it('truncates with a marker', () => {
    expect(truncate('abcdef', 3)).toBe('abc […]');
    expect(truncate('abc', 3)).toBe('abc');
  });
  it('takes the first name only, with a fallback', () => {
    expect(firstName('Rahul Kumar Sharma')).toBe('Rahul');
    expect(firstName('  ')).toBe('there');
    expect(firstName(null, 'Student')).toBe('Student');
  });
});

describe('minimiseConversation (§81)', () => {
  const messages = [
    { direction: 'OUTBOUND' as const, at: '2026-09-01T10:00:00Z', plainText: 'Please complete RPG by Friday. Contact ops@masaischool.com' },
    { direction: 'INBOUND' as const, at: '2026-09-02T10:00:00Z', plainText: 'Done!\n\nOn Mon, Team wrote:\n> Please complete RPG', snippet: 'Done!' },
    { direction: 'INBOUND' as const, at: '2026-09-03T10:00:00Z', html: '<p>Also, my number is +91 9876543210</p><style>p{}</style>' },
  ];

  it('orders oldest-first, maps direction, strips quotes, redacts, converts html', () => {
    const ctx = minimiseConversation(messages);
    expect(ctx.map((m) => m.from)).toEqual(['team', 'student', 'student']);
    expect(ctx[0]?.text).toBe('Please complete RPG by Friday. Contact [email]');
    expect(ctx[1]?.text).toBe('Done!');
    expect(ctx[2]?.text).toBe('Also, my number is [phone]');
  });

  it('keeps only the last N messages and caps each one', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      direction: 'INBOUND' as const,
      at: new Date(2026, 0, i + 1).toISOString(),
      plainText: 'x'.repeat(5000),
    }));
    const ctx = minimiseConversation(many, { maxMessages: 3, maxCharsPerMessage: 100 });
    expect(ctx).toHaveLength(3);
    expect(ctx[0]?.text.length).toBeLessThan(110);
  });

  it('falls back to the snippet when there is no body', () => {
    const ctx = minimiseConversation([{ direction: 'INBOUND', at: null, snippet: 'just the snippet' }]);
    expect(ctx[0]?.text).toBe('just the snippet');
    expect(ctx[0]?.at).toBe('');
  });
});

describe('prompt builders', () => {
  const ctx = {
    recipientFirstName: 'Rahul',
    senderName: 'Abhishesh',
    subject: 'RPG clearance',
    messages: [
      { from: 'team' as const, at: '2026-09-01T10:00:00.000Z', text: 'Please complete RPG.' },
      { from: 'student' as const, at: '2026-09-02T10:00:00.000Z', text: 'Done, thanks!' },
    ],
  };

  it('lists only the given variables for generation and forbids inventing', () => {
    const p = generateEmailPrompt({ brief: 'RPG reminder', variables: ['Name', 'Deadline'] });
    expect(p).toContain('{{Name}}, {{Deadline}}');
    expect(p).toContain('use only these');
  });

  it('wraps input text in delimiters and names the mode', () => {
    const p = improveTextPrompt({ text: 'hello', mode: 'shorten', format: 'text', variables: [] });
    expect(p).toContain('--- INPUT START ---\nhello\n--- INPUT END ---');
    expect(p).toMatch(/shorter/);
    expect(improveTextPrompt({ text: 'x', mode: 'translate', format: 'text', language: 'Hindi', variables: [] })).toContain('Target language: Hindi');
  });

  it('builds a transcript with names, not addresses', () => {
    const p = summarizePrompt(ctx);
    expect(p).toContain('[Abhishesh · 2026-09-01]');
    expect(p).toContain('[Rahul · 2026-09-02]');
    expect(p).not.toContain('@');
  });

  it('classifies the latest student message and lists every intent', () => {
    const p = classifyPrompt(ctx);
    expect(p).toContain('Latest student message to classify:\nDone, thanks!');
    for (const intent of ['COMPLETED', 'QUESTION', 'COMPLAINT', 'OUT_OF_OFFICE', 'AUTO_REPLY', 'UNKNOWN']) expect(p).toContain(intent);
  });

  it('suggests a reply with the right greeting, sign-off and style', () => {
    expect(suggestReplyPrompt(ctx)).toContain('Start with "Hi Rahul,"');
    expect(suggestReplyPrompt(ctx)).toContain('Regards,\nAbhishesh');
    expect(suggestReplyPrompt(ctx, 'shorter')).toContain('very short');
    expect(suggestReplyPrompt(ctx, 'formal')).toContain('formal register');
  });
});
