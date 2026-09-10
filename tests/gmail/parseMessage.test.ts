import { describe, it, expect } from 'vitest';
import {
  parseGmailMessage,
  parseAddressList,
  decodeBase64Url,
  normalizeSubject,
  type GmailMessage,
} from '@/lib/gmail/parseMessage';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function gmailFixture(overrides: Partial<GmailMessage> = {}, headers: Record<string, string> = {}): GmailMessage {
  const h = {
    From: 'Rahul Sharma <rahul@example.com>',
    To: 'abhishesh@masaischool.com',
    Subject: 'Re: RPG Clearance',
    'Message-ID': '<reply-1@example.com>',
    'In-Reply-To': '<orig-1@masaischool.com>',
    References: '<orig-1@masaischool.com>',
    Date: 'Fri, 05 Sep 2026 10:00:00 +0530',
    ...headers,
  };
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'I have completed the RPG',
    internalDate: String(Date.UTC(2026, 8, 5, 4, 30, 0)),
    payload: {
      mimeType: 'multipart/alternative',
      headers: Object.entries(h).map(([name, value]) => ({ name, value })),
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('I have completed the RPG.') } },
        { mimeType: 'text/html', body: { data: b64url('<p>I have completed the RPG.</p>') } },
      ],
    },
    ...overrides,
  };
}

describe('decodeBase64Url', () => {
  it('decodes unpadded base64url', () => {
    expect(decodeBase64Url(b64url('hello world'))).toBe('hello world');
  });
  it('handles the URL-safe alphabet', () => {
    const original = 'a+b/c?d';
    expect(decodeBase64Url(b64url(original))).toBe(original);
  });
  it('returns empty for missing data', () => {
    expect(decodeBase64Url(null)).toBe('');
  });
});

describe('parseAddressList', () => {
  it('parses "Name <addr>"', () => {
    expect(parseAddressList('Rahul Sharma <rahul@example.com>')).toEqual([{ name: 'Rahul Sharma', email: 'rahul@example.com' }]);
  });
  it('parses a bare address', () => {
    expect(parseAddressList('rahul@example.com')).toEqual([{ name: null, email: 'rahul@example.com' }]);
  });
  it('parses a comma-separated list', () => {
    expect(parseAddressList('a@x.test, B <b@x.test>')).toEqual([
      { name: null, email: 'a@x.test' },
      { name: 'B', email: 'b@x.test' },
    ]);
  });
  it('keeps a comma inside a quoted display name together', () => {
    expect(parseAddressList('"Sharma, Rahul" <rahul@example.com>')).toEqual([{ name: 'Sharma, Rahul', email: 'rahul@example.com' }]);
  });
  it('lowercases addresses and skips junk with no @', () => {
    expect(parseAddressList('Rahul@Example.COM, not-an-address')).toEqual([{ name: null, email: 'rahul@example.com' }]);
  });
  it('returns empty for missing header', () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('parseGmailMessage', () => {
  it('extracts ids, threading headers and both bodies', () => {
    const m = parseGmailMessage(gmailFixture());
    expect(m.gmailMessageId).toBe('msg-1');
    expect(m.gmailThreadId).toBe('thread-1');
    expect(m.from).toEqual({ name: 'Rahul Sharma', email: 'rahul@example.com' });
    expect(m.to[0]?.email).toBe('abhishesh@masaischool.com');
    expect(m.subject).toBe('Re: RPG Clearance');
    expect(m.messageIdHeader).toBe('<reply-1@example.com>');
    expect(m.inReplyTo).toBe('<orig-1@masaischool.com>');
    expect(m.references).toBe('<orig-1@masaischool.com>');
    expect(m.plainTextBody).toBe('I have completed the RPG.');
    expect(m.htmlBody).toBe('<p>I have completed the RPG.</p>');
    expect(m.labelIds).toContain('INBOX');
  });

  it('uses the Date header for sentAt and internalDate for receivedAt', () => {
    const m = parseGmailMessage(gmailFixture());
    expect(m.sentAt.toISOString()).toBe('2026-09-05T04:30:00.000Z');
    expect(m.receivedAt.getTime()).toBe(Date.UTC(2026, 8, 5, 4, 30, 0));
  });

  it('falls back to receivedAt when the Date header is unparseable', () => {
    const m = parseGmailMessage(gmailFixture({}, { Date: 'garbage' }));
    expect(m.sentAt.getTime()).toBe(m.receivedAt.getTime());
  });

  it('finds bodies nested inside multipart/mixed with an attachment', () => {
    const fixture = gmailFixture({
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'From', value: 'a@x.test' }, { name: 'Subject', value: 's' }],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('plain') } },
              { mimeType: 'text/html', body: { data: b64url('<b>html</b>') } },
            ],
          },
          {
            mimeType: 'application/pdf',
            filename: 'resume.pdf',
            body: { attachmentId: 'att-1', size: 12345 },
          },
        ],
      },
    });
    const m = parseGmailMessage(fixture);
    expect(m.plainTextBody).toBe('plain');
    expect(m.htmlBody).toBe('<b>html</b>');
    expect(m.attachments).toEqual([{ filename: 'resume.pdf', mimeType: 'application/pdf', size: 12345, gmailAttachmentId: 'att-1' }]);
  });

  it('handles a single-part text/plain message with no parts array', () => {
    const fixture = gmailFixture({
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'a@x.test' }, { name: 'Subject', value: 's' }],
        body: { data: b64url('just text') },
      },
    });
    const m = parseGmailMessage(fixture);
    expect(m.plainTextBody).toBe('just text');
    expect(m.htmlBody).toBeNull();
  });

  it('exposes a lower-cased header map for the classifier', () => {
    const m = parseGmailMessage(gmailFixture({}, { 'Auto-Submitted': 'auto-replied' }));
    expect(m.headers['auto-submitted']).toBe('auto-replied');
    expect(m.headers['from']).toContain('rahul@example.com');
  });

  it('throws when the message has no id or threadId', () => {
    expect(() => parseGmailMessage({ id: null, threadId: 't' })).toThrow();
    expect(() => parseGmailMessage({ id: 'x', threadId: null })).toThrow();
  });
});

describe('normalizeSubject', () => {
  it('strips stacked Re:/Fwd: prefixes', () => {
    expect(normalizeSubject('Re: RE: Fwd: FW: RPG Clearance')).toBe('RPG Clearance');
  });
  it('leaves a plain subject alone', () => {
    expect(normalizeSubject('RPG Clearance')).toBe('RPG Clearance');
  });
  it('does not strip a word that merely starts with re', () => {
    expect(normalizeSubject('Results are in')).toBe('Results are in');
  });
});
