import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Gmail push watches the inbox only: watching Sent would wake a function for every email
 * MailFlow sends (free-plan cost); team replies sent from Gmail still come in with the sync.
 */
const watch = vi.fn(async () => ({ data: { expiration: String(Date.now() + 7 * 86_400_000), historyId: '500' } }));
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { watch } }) }));
vi.mock('@/lib/gmail/oauth', () => ({ authorizedClientFor: vi.fn(async () => ({})) }));
const db = { emailProviderAccount: { update: vi.fn(async () => ({})) } };
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const { ensureWatch, WATCH_LABELS } = await import('@/lib/gmail/watch');

const account = { id: 'a1', status: 'CONNECTED', refreshTokenEnc: 'x', watchExpiresAt: null, gmailHistoryId: '1' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GMAIL_PUBSUB_TOPIC = 'projects/p/topics/t';
});

describe('Gmail watch', () => {
  it('watches INBOX only, not SENT', async () => {
    expect(WATCH_LABELS).toEqual(['INBOX']);
    await ensureWatch(account);
    expect(watch).toHaveBeenCalledWith({ userId: 'me', requestBody: { topicName: 'projects/p/topics/t', labelIds: ['INBOX'], labelFilterBehavior: 'include' } });
  });

  it('does nothing when push is off', async () => {
    delete process.env.GMAIL_PUBSUB_TOPIC;
    expect(await ensureWatch(account)).toBeNull();
    expect(watch).not.toHaveBeenCalled();
  });
});
