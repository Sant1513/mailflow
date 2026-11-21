import { describe, expect, it } from 'vitest';
import { emailKey } from '@/lib/recruiterSend/emailKey';
import { clampRepeatDays, windowWarning } from '@/lib/recruiterSend/repeatDays';
import { parseRecipientPaste } from '@/lib/recruiterSend/core';

describe('emailKey', () => {
  it('treats Gmail dots, +tags, case and googlemail.com as one inbox', () => {
    const same = ['a.b@gmail.com', 'ab@gmail.com', 'AB@Gmail.com', 'ab+news@gmail.com', 'a.b+x+y@gmail.com', ' ab@gmail.com ', 'a.b@googlemail.com'];
    for (const e of same) expect(emailKey(e), e).toBe('ab@gmail.com');
  });
  it('keeps dots and tags on every other domain (a company can tell them apart)', () => {
    expect(emailKey('A.B@Company.com')).toBe('a.b@company.com');
    expect(emailKey('ab+x@company.com')).toBe('ab+x@company.com');
    expect(emailKey('a.b@company.com')).not.toBe(emailKey('ab@company.com'));
    expect(emailKey('a.b@gmail.com.evil.test')).toBe('a.b@gmail.com.evil.test');
  });
  it('is safe on odd input', () => {
    expect(emailKey('')).toBe('');
    expect(emailKey(null)).toBe('');
    expect(emailKey(undefined)).toBe('');
    expect(emailKey('no-at-sign')).toBe('no-at-sign');
    expect(emailKey('+tag@gmail.com')).toBe('@gmail.com');
  });
});

describe('a pasted list', () => {
  it('counts the same Gmail inbox once, keeping the first spelling', () => {
    const { recipients } = parseRecipientPaste('Asha <a.sha@gmail.com>\nasha+jobs@gmail.com\nASHA@gmail.com\nraj@company.com\nr.aj@company.com');
    expect(recipients.map((r) => r.email)).toEqual(['a.sha@gmail.com', 'raj@company.com', 'r.aj@company.com']);
  });
  it('does the same for a table with columns', () => {
    const { recipients } = parseRecipientPaste('Name\tEmail\nA\ta.b@gmail.com\nB\tab+x@gmail.com\nC\tc@x.com');
    expect(recipients.map((r) => r.email)).toEqual(['a.b@gmail.com', 'c@x.com']);
  });
});

describe('repeat window helpers', () => {
  it('clamps to 0..90 and defaults to 10', () => {
    expect(clampRepeatDays(null)).toBe(10);
    expect(clampRepeatDays(0)).toBe(0);
    expect(clampRepeatDays(200)).toBe(90);
    expect(clampRepeatDays(-3)).toBe(0);
    expect(clampRepeatDays(Number.NaN)).toBe(10);
  });
  it('warns under 7 days and when off, and is quiet from 7', () => {
    expect(windowWarning(0)).toMatch(/check is off/);
    expect(windowWarning(1)).toMatch(/Under 7 days/);
    expect(windowWarning(6)).toMatch(/Under 7 days/);
    expect(windowWarning(7)).toBeNull();
    expect(windowWarning(10)).toBeNull();
    expect(windowWarning(90)).toBeNull();
  });
});
