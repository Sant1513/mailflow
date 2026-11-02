import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/webhooks/dispatch', () => ({ dispatchWebhook: vi.fn() }));
const { parseBounce } = await import('@/lib/email/bounces');

const own = ['abhishesh.kumar@masaischool.com'];

describe('bounce notices', () => {
  it('reads Gmail\'s "Address not found" notice', () => {
    const info = parseBounce(
      {
        subject: 'Delivery Status Notification (Failure)',
        plainTextBody:
          "** Address not found **\n\nYour message wasn't delivered to rahul.sharma@gmial.com because the address couldn't be found, or is unable to receive mail.\n\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.",
        htmlBody: null,
      },
      own,
    );
    expect(info.recipients).toEqual(['rahul.sharma@gmial.com']);
    expect(info.permanent).toBe(true);
    expect(info.detail).toMatch(/5\.1\.1/);
  });

  it('reads an Outlook / Exchange notice and the delivery-status part', () => {
    const info = parseBounce(
      {
        subject: 'Undeliverable: Masai Placement Drive',
        plainTextBody:
          "Delivery has failed to these recipients or groups:\n\nneha@college.edu.in\nThe email address you entered couldn't be found.\n\nReporting-MTA: dns; outlook.com\nFinal-Recipient: rfc822; neha@college.edu.in\nAction: failed\nStatus: 5.1.10\nDiagnostic-Code: smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound",
        htmlBody: null,
      },
      own,
    );
    expect(info.recipients).toEqual(['neha@college.edu.in']);
    expect(info.permanent).toBe(true);
  });

  it('uses the X-Failed-Recipients header', () => {
    const info = parseBounce(
      { headers: { 'x-failed-recipients': 'amit@example.org' }, plainTextBody: 'This message was created automatically by mail delivery software.\n550 No such user here', htmlBody: null },
      own,
    );
    expect(info.recipients).toEqual(['amit@example.org']);
    expect(info.permanent).toBe(true);
  });

  it('does not treat a full mailbox or a delay as permanent', () => {
    const full = parseBounce(
      {
        subject: 'Delivery Status Notification (Delay)',
        plainTextBody:
          "Your message to priya@example.com has been delayed. Gmail will retry for 46 more hours.\n452 4.2.2 The email account that you tried to reach is over quota.",
        htmlBody: null,
      },
      own,
    );
    expect(full.permanent).toBe(false);
  });

  it('never names our own mailbox or the mailer-daemon as the failed address', () => {
    const info = parseBounce(
      {
        plainTextBody:
          "From: abhishesh.kumar@masaischool.com\nmailer-daemon@googlemail.com\nYour message wasn't delivered to student@nowhere.test because the address couldn't be found.",
        htmlBody: null,
      },
      own,
    );
    expect(info.recipients).toEqual(['student@nowhere.test']);
  });

  it('finds the address in an HTML-only notice', () => {
    const info = parseBounce(
      { plainTextBody: null, htmlBody: '<p>Your message wasn&#39;t delivered to <b>x.y@domain.co</b> because the address couldn&#39;t be found.</p><p>550 5.1.1</p>' },
      own,
    );
    expect(info.recipients).toEqual(['x.y@domain.co']);
    expect(info.permanent).toBe(true);
  });
});
