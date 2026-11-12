import { describe, expect, it } from 'vitest';
import { parseGmailMessage } from '@/lib/gmail/parseMessage';
import { classifyInbound } from '@/lib/conversations/classify';
import {
  bounceSkipReason,
  categorize,
  detectLeftCompany,
  looksLikeDeliveryReport,
  parseDeliveryReport,
  suppressionRule,
  type ReportSource,
} from '@/lib/email/dsn';
import { fixture, rawToGmail } from '../fixtures/ndr/mime';

/**
 * Bounce / NDR / DSN parsing (lib/email/dsn.ts) on realistic raw messages, including the two
 * production notices MailFlow missed on 2026-11-12 (an Office 365 "wasn't found at" NDR and a
 * Gmail "Message blocked" 452 4.7.1 DSN for a BCC send).
 */
const parse = (name: string, own: string[]) => {
  const message = parseGmailMessage(rawToGmail(fixture(name)));
  return { message, report: parseDeliveryReport(message, own) };
};

const text = (subject: string, body: string, extra: Partial<ReportSource> = {}): ReportSource => ({
  subject,
  from: { email: 'mailer-daemon@mx.example.net', name: 'Mail Delivery System' },
  headers: {},
  plainTextBody: body,
  htmlBody: null,
  ...extra,
});
const first = (r: ReturnType<typeof parseDeliveryReport>) => r!.failures[0]!;

describe('real notices that were missed', () => {
  it('Office 365 "thakurayush wasn\'t found at atfenix.com" (5.1.10) → USER_UNKNOWN, suppressed, matched by the embedded Message-ID', () => {
    const { message, report } = parse('o365-user-unknown.eml', ['apollo.moirangthem@masaischool.com']);
    expect(classifyInbound(message).classification).toMatch(/BOUNCE|DELIVERY_FAILURE/);
    expect(message.report?.deliveryStatus).toContain('Final-Recipient');
    expect(report!.kind).toBe('BOUNCE');
    expect(report!.failures).toHaveLength(1);
    expect(first(report)).toMatchObject({ email: 'thakurayush@atfenix.com', action: 'failed', final: true, statusCode: '5.1.10', category: 'USER_UNKNOWN' });
    expect(first(report).diagnostic).toContain('RecipientNotFound');
    // No In-Reply-To on an O365 NDR: the original's Message-ID from the attached copy is what ties it to our send.
    expect(message.inReplyTo).toBeNull();
    expect(report!.originalMessageId).toBe('<CAJ7rd2kQ0n=individual-copy-77@mail.gmail.com>');
    expect(report!.referencedIds).toEqual(['<CAJ7rd2kQ0n=individual-copy-77@mail.gmail.com>']);
    expect(suppressionRule(first(report).category)).toBe('NOW');
    // The copy of the original isn't taken for the notice's own text.
    expect(message.plainTextBody).toContain("couldn't be delivered");
  });

  it('the same Office 365 NDR read from its text alone (no delivery-status part)', () => {
    const { message } = parse('o365-user-unknown.eml', []);
    const report = parseDeliveryReport({ ...message, report: null, headers: { ...message.headers, 'content-type': 'text/plain' } }, ['apollo.moirangthem@masaischool.com']);
    expect(first(report)).toMatchObject({ email: 'thakurayush@atfenix.com', final: true, category: 'USER_UNKNOWN' });
    expect(first(report).statusCode).toMatch(/^5\.1\.10$|^550$/);
  });

  it('Gmail "Message blocked … 452 4.7.1 Mailbox delivery restricted by policy" is final → POLICY_BLOCK, suppressed', () => {
    const { message, report } = parse('gmail-message-blocked.eml', ['placements.bcc@masaischool.com']);
    expect(classifyInbound(message).classification).toMatch(/BOUNCE|DELIVERY_FAILURE/);
    expect(first(report)).toMatchObject({ email: 'jannat.t@healthfab.in', action: 'failed', final: true, statusCode: '4.7.1', category: 'POLICY_BLOCK' });
    expect(first(report).diagnostic).toBe('452 4.7.1 Mailbox delivery restricted by policy error');
    expect(report!.referencedIds).toContain('<CAKbcc-group-2-set2@mail.gmail.com>');
    expect(suppressionRule('POLICY_BLOCK')).toBe('NOW');
    expect(bounceSkipReason(first(report))).toBe("Bounced: Blocked by the recipient's mail policy (4.7.1)");
  });

  it('the Gmail notice read from its text alone is still final (Gmail stopped retrying), not a delay', () => {
    const r = parseDeliveryReport(
      text(
        'Delivery Status Notification (Failure)',
        '** Message blocked **\n\nYour message to jannat.t@healthfab.in has been blocked. See technical details below for more information.\n\nThe response from the remote server was:\n452 4.7.1 Mailbox delivery restricted by policy error',
      ),
    );
    expect(first(r)).toMatchObject({ email: 'jannat.t@healthfab.in', final: true, statusCode: '4.7.1', category: 'POLICY_BLOCK' });
  });
});

describe('structured reports and common servers', () => {
  it('Postfix multipart/report: User unknown (5.1.1), original headers from text/rfc822-headers', () => {
    const { report } = parse('postfix-user-unknown.eml', ['placements@masaischool.com']);
    expect(report!.failures).toHaveLength(1);
    expect(first(report)).toMatchObject({ email: 'rohit.verma@example.org', statusCode: '5.1.1', category: 'USER_UNKNOWN', final: true });
    expect(report!.originalMessageId).toBe('<job-4411@masaischool.com>');
  });

  it('a delay (Action: delayed, 4xx) is TEMPORARY and never suppresses', () => {
    const { report } = parse('gmail-delay.eml', ['placements@masaischool.com']);
    expect(first(report)).toMatchObject({ email: 'neha@slow.example.in', action: 'delayed', final: false, category: 'TEMPORARY' });
    expect(suppressionRule('TEMPORARY')).toBe('NEVER');
  });

  it('Gmail "Address not found" (550 5.1.1) → USER_UNKNOWN', () => {
    const r = parseDeliveryReport(text('Delivery Status Notification (Failure)', "** Address not found **\n\nYour message wasn't delivered to rahul@gmial.com because the address couldn't be found, or is unable to receive mail.\n\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist."));
    expect(first(r)).toMatchObject({ email: 'rahul@gmial.com', category: 'USER_UNKNOWN', statusCode: '5.1.1' });
  });

  it('Gmail DNS error → DOMAIN_NOT_FOUND', () => {
    const r = parseDeliveryReport(text('Delivery Status Notification (Failure)', "** Address not found **\n\nYour message wasn't delivered to a@nodomain-xyz.in because the domain nodomain-xyz.in couldn't be found. Check for typos or unnecessary spaces and try again.\n\nThe response was:\nDNS Error: DNS type 'mx' lookup of nodomain-xyz.in responded with code NXDOMAIN Domain name not found: nodomain-xyz.in"));
    expect(first(r)).toMatchObject({ email: 'a@nodomain-xyz.in', category: 'DOMAIN_NOT_FOUND', final: true });
  });

  it('mailbox full (552 5.2.2) → MAILBOX_FULL, suppressed only on a repeat', () => {
    const r = parseDeliveryReport(text('Delivery Status Notification (Failure)', "** Message not delivered **\n\nYour message couldn't be delivered to priya@example.com because the recipient's inbox is full.\n\nThe response from the remote server was:\n552 5.2.2 The email account that you tried to reach is over quota and inactive."));
    expect(first(r)).toMatchObject({ email: 'priya@example.com', category: 'MAILBOX_FULL', statusCode: '5.2.2' });
    expect(suppressionRule('MAILBOX_FULL')).toBe('ON_REPEAT');
  });

  it('disabled account (550 5.2.1) → MAILBOX_DISABLED', () => {
    const r = parseDeliveryReport(text('Delivery Status Notification (Failure)', "Your message wasn't delivered to old@example.com.\nThe response from the remote server was:\n550 5.2.1 The email account that you tried to reach is disabled."));
    expect(first(r).category).toBe('MAILBOX_DISABLED');
  });

  it('Office 365 "Recipient address rejected: Access denied" (5.4.1) → POLICY_BLOCK', () => {
    const r = parseDeliveryReport(text('Undeliverable: Hiring partners', "Your message to hr@tenant.example couldn't be delivered.\nRemote server returned '550 5.4.1 Recipient address rejected: Access denied. AS(201806281) [BN8NAM12FT047.eop-nam12.prod.protection.outlook.com]'"));
    expect(first(r)).toMatchObject({ email: 'hr@tenant.example', category: 'POLICY_BLOCK', statusCode: '5.4.1' });
  });

  it('Office 365 group delivery restriction (5.7.133) → POLICY_BLOCK, not a spam block', () => {
    const r = parseDeliveryReport(text('Undeliverable: Hiring partners', "Your message to all-staff@corp.example couldn't be delivered.\nRemote server returned '550 5.7.133 RESOLVER.RST.SenderNotAuthenticatedForGroup; authentication required; Delivery restriction check failed as sender not authenticated'"));
    expect(first(r).category).toBe('POLICY_BLOCK');
  });

  it('spam / blocklist / DMARC rejections → SPAM_BLOCK', () => {
    const spam = parseDeliveryReport(text('Undelivered Mail Returned to Sender', '<x@corp.example>: host mx.corp.example said: 550 5.7.1 Message rejected as spam by Content Filtering.'));
    expect(first(spam)).toMatchObject({ email: 'x@corp.example', category: 'SPAM_BLOCK' });
    const dmarc = parseDeliveryReport(text('Delivery Status Notification (Failure)', "Your message wasn't delivered to y@corp.example.\nThe response was:\n550 5.7.26 Unauthenticated email from masaischool.com is not accepted due to domain's DMARC policy."));
    expect(first(dmarc).category).toBe('SPAM_BLOCK');
  });

  it('message too large (552 5.3.4) → MESSAGE_TOO_LARGE, which never suppresses the address', () => {
    const r = parseDeliveryReport(text('Undelivered Mail Returned to Sender', '<big@corp.example>: host mx.corp.example said: 552 5.3.4 Message size exceeds fixed maximum message size'));
    expect(first(r).category).toBe('MESSAGE_TOO_LARGE');
    expect(suppressionRule('MESSAGE_TOO_LARGE')).toBe('NEVER');
  });

  it('Exim "SMTP error from remote mail server after RCPT TO" → USER_UNKNOWN', () => {
    const r = parseDeliveryReport(text('Mail delivery failed: returning message to sender', 'This message was created automatically by mail delivery software.\n\nA message that you sent could not be delivered to one or more of its\nrecipients. This is a permanent error. The following address(es) failed:\n\n  anil@exim.example\n    host mx.exim.example [198.51.100.7]\n    SMTP error from remote mail server after RCPT TO:<anil@exim.example>:\n    550 No such user here', { headers: { 'x-failed-recipients': 'anil@exim.example' } }));
    expect(first(r)).toMatchObject({ email: 'anil@exim.example', category: 'USER_UNKNOWN', statusCode: '550' });
  });

  it('Yahoo "This user doesn\'t have a yahoo.com account" → USER_UNKNOWN', () => {
    const r = parseDeliveryReport(text('Failure Notice', "Sorry, we were unable to deliver your message to the following address.\n\n<nobody123@yahoo.com>:\n554: delivery error: dd This user doesn't have a yahoo.com account (nobody123@yahoo.com) [-5] - mta4471.mail.gq1.yahoo.com"));
    expect(first(r)).toMatchObject({ email: 'nobody123@yahoo.com', category: 'USER_UNKNOWN' });
  });

  it('Zoho "Invalid Address" → USER_UNKNOWN', () => {
    const r = parseDeliveryReport(text('Undelivered Mail Returned to Sender', 'This message was created automatically by mail delivery software.\nA message that you sent could not be delivered to one or more of its recipients. This is a permanent error.\n\nInvalid Address: hr@zoho-client.example\nReason: 550 5.1.1 User does not exist - <hr@zoho-client.example>'));
    expect(first(r)).toMatchObject({ email: 'hr@zoho-client.example', category: 'USER_UNKNOWN' });
  });

  it('generic "relay access denied" and "mailbox unavailable"', () => {
    expect(first(parseDeliveryReport(text('Returned mail', '<a@b.example>: 554 5.7.1 <a@b.example>: Relay access denied'))).category).toBe('POLICY_BLOCK');
    expect(first(parseDeliveryReport(text('Returned mail', '<c@d.example>: 550 Requested action not taken: mailbox unavailable'))).category).toBe('USER_UNKNOWN');
  });

  it('never names our own mailbox or the mailer-daemon as the failed address', () => {
    const r = parseDeliveryReport(text('Delivery Status Notification (Failure)', "From: me@masaischool.com\nmailer-daemon@googlemail.com\nYour message wasn't delivered to student@nowhere.test because the address couldn't be found. 550 5.1.1"), ['me@masaischool.com']);
    expect(r!.failures.map((f) => f.email)).toEqual(['student@nowhere.test']);
  });

  it('a notice that names no address leaves it to the matched send', () => {
    const r = parseDeliveryReport(text('Undeliverable: hello', 'Delivery has failed. 550 5.1.1 user unknown'));
    expect(r!.failures).toHaveLength(1);
    expect(first(r)).toMatchObject({ email: null, category: 'USER_UNKNOWN' });
  });

  it('ordinary mail is not a delivery report', () => {
    expect(parseDeliveryReport({ subject: 'Re: Hiring partners', from: { email: 'priya@corp.example', name: 'Priya' }, headers: {}, plainTextBody: 'Thanks, interested.', htmlBody: null })).toBeNull();
  });
});

describe('categorize', () => {
  it('a final 4xx with nothing recognisable stays TEMPORARY; an unrecognised 5xx is OTHER_HARD', () => {
    expect(categorize({ final: true, statusCode: '4.4.7', diagnostic: '421 4.4.7 Message expired' })).toBe('TEMPORARY');
    expect(categorize({ final: true, statusCode: '5.0.0', diagnostic: '554 5.0.0 Service unavailable' })).toBe('OTHER_HARD');
    expect(categorize({ final: false, statusCode: '5.1.1', diagnostic: 'user unknown' })).toBe('TEMPORARY');
  });
});

describe('complaints and left-the-company replies', () => {
  it('an ARF spam complaint → COMPLAINT for the original recipient', () => {
    const { report } = parse('arf-complaint.eml', ['placements@masaischool.com']);
    expect(report!.kind).toBe('COMPLAINT');
    expect(first(report)).toMatchObject({ email: 'annoyed.user@yahoo.com', category: 'COMPLAINT' });
    expect(report!.originalMessageId).toBe('<job-8100@masaischool.com>');
  });

  it('"is no longer with … this mailbox is not monitored" auto-reply → a left-the-company phrase', () => {
    const message = parseGmailMessage(rawToGmail(fixture('left-company.eml')));
    expect(classifyInbound(message).classification).toBe('OUT_OF_OFFICE');
    expect(detectLeftCompany(message)).toContain('no longer with BigCorp');
  });

  it('other phrasings, and ordinary out-of-office replies that are not', () => {
    const t = (s: string) => detectLeftCompany({ plainTextBody: s, htmlBody: null });
    expect(t('Please note that I have left the company. Contact hr@x.com.')).not.toBeNull();
    expect(t('This email address is no longer monitored.')).not.toBeNull();
    expect(t('This mailbox has been deactivated.')).not.toBeNull();
    expect(t('I am out of office until Monday with limited access to email.')).toBeNull();
    expect(t('I have left for the day and will reply tomorrow.')).toBeNull();
    // A quoted original below the reply is not read.
    expect(t('Thanks!\n\nOn Tue, 11 Nov 2026 Placements wrote:\n> Our previous contact is no longer with the company')).toBeNull();
  });
});

describe('sync triage, from headers only', () => {
  it('picks up NDRs from postmaster@ / mailer-daemon@, "Mail Delivery System", multipart/report and X-Failed-Recipients', () => {
    expect(looksLikeDeliveryReport({ fromEmail: 'postmaster@atfenix.com', subject: 'Undeliverable: hi' })).toBe(true);
    expect(looksLikeDeliveryReport({ fromEmail: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)' })).toBe(true);
    expect(looksLikeDeliveryReport({ fromEmail: 'microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@corp.example', fromName: 'Microsoft Outlook', subject: 'Undeliverable: hi' })).toBe(true);
    expect(looksLikeDeliveryReport({ fromEmail: 'noc@isp.example', fromName: 'Mail Delivery System', subject: 'Returned mail: see transcript', autoSubmitted: 'auto-generated' })).toBe(true);
    expect(looksLikeDeliveryReport({ fromEmail: 'x@y.example', contentType: 'multipart/report; report-type=delivery-status' })).toBe(true);
    expect(looksLikeDeliveryReport({ fromEmail: 'x@y.example', failedRecipients: 'a@b.example' })).toBe(true);
    expect(looksLikeDeliveryReport({ fromEmail: 'friend@gmail.com', subject: 'Lunch?' })).toBe(false);
  });
});
