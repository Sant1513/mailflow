import { describe, expect, it } from 'vitest';
import { coolOffReason, repeatReason, repeatWindow, type RecentContact } from '@/lib/recruiterSend/recent';

const NOW = new Date('2026-11-20T10:00:00Z');
const contact = (over: Partial<RecentContact> = {}): RecentContact => ({ email: 'a@b.com', at: new Date('2026-11-17T09:00:00Z'), pending: false, subject: 'Hiring drive', source: 'Recruiter send “Dec drive”', kind: 'send', from: 'me@masaischool.com', count: 1, ...over });

describe('repeatWindow', () => {
  it('keeps 0..90 and falls back to 10 for junk', () => {
    expect(repeatWindow(10)).toBe(10);
    expect(repeatWindow(0)).toBe(0);
    expect(repeatWindow(500)).toBe(90);
    expect(repeatWindow(-4)).toBe(0);
    expect(repeatWindow(undefined)).toBe(10);
    expect(repeatWindow(null)).toBe(10);
    expect(repeatWindow(NaN)).toBe(10);
    expect(repeatWindow(2.9)).toBe(2);
  });
});

describe('repeatReason', () => {
  it('says when, the subject, the mailbox and which send', () => {
    const r = repeatReason(contact(), NOW);
    expect(r).toContain('Emailed 3 days ago');
    expect(r).toContain('“Hiring drive”');
    expect(r).toContain('from me@masaischool.com');
    expect(r).toContain('Recruiter send “Dec drive”');
  });
  it('today and yesterday read naturally', () => {
    expect(repeatReason(contact({ at: new Date('2026-11-20T08:00:00Z') }), NOW)).toContain('Emailed today');
    expect(repeatReason(contact({ at: new Date('2026-11-19T08:00:00Z') }), NOW)).toContain('Emailed yesterday');
  });
  it('a manual Inbox reply says "You replied"', () => {
    const r = repeatReason(contact({ kind: 'reply', source: 'Inbox reply', subject: 'Re: your question' }), NOW);
    expect(r).toContain('You replied 3 days ago');
    expect(r).toContain('Inbox reply');
  });
  it('a queued send says it is going out soon', () => {
    expect(repeatReason(contact({ pending: true, source: 'Recruiter send “Queued”' }), NOW)).toMatch(/Already in Recruiter send “Queued”, going out soon/);
  });
  it('cuts a very long subject and mentions several emails', () => {
    const r = repeatReason(contact({ subject: 'x'.repeat(300), count: 3 }), NOW);
    expect(r.length).toBeLessThan(320);
    expect(r).toContain('3 emails in the window');
  });
});

describe('coolOffReason', () => {
  it('names the date and the note, and says where to change it', () => {
    const r = coolOffReason({ until: new Date('2026-12-05T00:00:00Z'), note: 'On leave until December' });
    expect(r).toContain('Do not contact until 5 Dec 2026');
    expect(r).toContain('On leave until December');
    expect(r).toContain('Change it on the contact');
  });
  it('works without a note and cuts a very long one', () => {
    expect(coolOffReason({ until: new Date('2026-12-05T00:00:00Z'), note: null })).toMatch(/^Do not contact until 5 Dec 2026\. /);
    expect(coolOffReason({ until: new Date('2026-12-05T00:00:00Z'), note: 'y'.repeat(300) }).length).toBeLessThan(160);
  });
});
