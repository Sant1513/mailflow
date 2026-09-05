import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * GmailProvider.sendEmail must report the Message-ID Gmail ACTUALLY
 * assigned, not the one we generated.
 *
 * Found by a live round-trip: Gmail replaces the MIME Message-ID on send
 * with its own <...@mail.gmail.com> value. A recipient's reply cites
 * Gmail's ID in In-Reply-To, so storing ours left threading-by-Message-ID
 * silently dead and put a phantom ID into every References chain. The fake
 * provider used elsewhere preserves the ID and would never have caught it.
 */

const sendMock = vi.fn();
const getMock = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    gmail: () => ({ users: { messages: { send: sendMock, get: getMock } } }),
  },
}));

vi.mock('@/lib/gmail/oauth', () => ({
  authorizedClientFor: vi.fn(async () => ({})),
  markAccountExpired: vi.fn(async () => undefined),
}));

const { GmailProvider } = await import('@/lib/email/gmail');

const account = {
  id: 'acct1',
  emailAddress: 'abhishesh@masaischool.com',
  displayName: 'Abhishesh',
  status: 'CONNECTED',
} as any;

const input = {
  to: 'student@example.com',
  fromName: 'Abhishesh',
  fromEmail: 'abhishesh@masaischool.com',
  subject: 'Hi',
  html: '<p>Hi</p>',
};

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockResolvedValue({ data: { id: 'gm-1', threadId: 'th-1', labelIds: ['SENT'] } });
});

describe('GmailProvider.sendEmail — Message-ID read-back', () => {
  it('returns the Message-ID Gmail assigned, not the generated one', async () => {
    getMock.mockResolvedValue({
      data: { payload: { headers: [{ name: 'Message-Id', value: '<CADvY+real@mail.gmail.com>' }] } },
    });

    const result = await new GmailProvider(account).sendEmail(input);

    expect(result.messageIdHeader).toBe('<CADvY+real@mail.gmail.com>');
    expect(result.providerMessageId).toBe('gm-1');
    expect(result.threadId).toBe('th-1');
  });

  it('reads the header back by id with metadata format, case-insensitively', async () => {
    getMock.mockResolvedValue({
      // Gmail spells it "Message-Id"; the lookup must not depend on casing.
      data: { payload: { headers: [{ name: 'MESSAGE-ID', value: '<x@mail.gmail.com>' }] } },
    });

    await new GmailProvider(account).sendEmail(input);

    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', id: 'gm-1', format: 'metadata', metadataHeaders: ['Message-Id'] })
    );
  });

  it('keeps our generated Message-ID (still a valid header) when the read-back fails', async () => {
    getMock.mockRejectedValue(new Error('transient'));

    const result = await new GmailProvider(account).sendEmail(input);

    // The send succeeded; a read-back failure must not turn it into a failure.
    expect(result.providerMessageId).toBe('gm-1');
    expect(result.messageIdHeader).toMatch(/^<.+@masaischool\.com>$/);
  });

  it('keeps the generated ID when Gmail returns no Message-Id header', async () => {
    getMock.mockResolvedValue({ data: { payload: { headers: [] } } });

    const result = await new GmailProvider(account).sendEmail(input);

    expect(result.messageIdHeader).toMatch(/^<.+@masaischool\.com>$/);
  });

  it('exposes the generated ID in raw so the substitution is auditable', async () => {
    getMock.mockResolvedValue({
      data: { payload: { headers: [{ name: 'Message-Id', value: '<real@mail.gmail.com>' }] } },
    });

    const result = await new GmailProvider(account).sendEmail(input);

    expect((result.raw as any).generatedMessageId).toMatch(/^<.+@masaischool\.com>$/);
    expect((result.raw as any).generatedMessageId).not.toBe(result.messageIdHeader);
  });

  it('still refuses to send from an address other than the connected mailbox (§28)', async () => {
    await expect(
      new GmailProvider(account).sendEmail({ ...input, fromEmail: 'someone-else@masaischool.com' })
    ).rejects.toThrow(/does not match the connected Gmail account/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
