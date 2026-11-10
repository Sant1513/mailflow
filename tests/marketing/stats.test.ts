import { beforeEach, describe, expect, it, vi } from 'vitest';

const counts = {
  emailJob: vi.fn(),
  recruiterBlastRecipient: vi.fn(),
  signingRequest: vi.fn(),
  emailProviderAccount: vi.fn(),
  conversationMessage: vi.fn(),
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    emailJob: { count: (...a: unknown[]) => counts.emailJob(...a) },
    recruiterBlastRecipient: { count: (...a: unknown[]) => counts.recruiterBlastRecipient(...a) },
    signingRequest: { count: (...a: unknown[]) => counts.signingRequest(...a) },
    emailProviderAccount: { count: (...a: unknown[]) => counts.emailProviderAccount(...a) },
    conversationMessage: { count: (...a: unknown[]) => counts.conversationMessage(...a) },
  },
}));
// unstable_cache needs Next's runtime; in tests it just calls through.
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));

import { roundDown, formatCounting } from '@/lib/marketing/format';
import { loadPublicStats, getPublicStats } from '@/lib/marketing/stats';

describe('roundDown', () => {
  it('hides zero, negative and non-finite counts', () => {
    expect(roundDown(0)).toBeNull();
    expect(roundDown(-4)).toBeNull();
    expect(roundDown(Number.NaN)).toBeNull();
    expect(roundDown(0.6)).toBeNull();
  });

  it('shows small counts exactly', () => {
    expect(roundDown(7)).toEqual({ value: 7, display: '7' });
    expect(roundDown(99)).toEqual({ value: 99, display: '99' });
  });

  it('always rounds down, never up', () => {
    expect(roundDown(128)).toEqual({ value: 120, display: '120+' });
    expect(roundDown(999)).toEqual({ value: 990, display: '990+' });
    expect(roundDown(6_432)).toEqual({ value: 6_400, display: '6,400+' });
    expect(roundDown(9_999)).toEqual({ value: 9_900, display: '9,900+' });
    expect(roundDown(12_950)).toEqual({ value: 12_000, display: '12k+' });
    expect(roundDown(1_269_000)).toEqual({ value: 1_200_000, display: '1.2M+' });
  });

  it('formats in-between counter values like the final value', () => {
    expect(formatCounting(4_321, 6_400)).toBe('4,321');
    expect(formatCounting(8_700, 12_000)).toBe('8k');
  });
});

describe('loadPublicStats', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    counts.emailJob.mockResolvedValue(5_000);
    counts.recruiterBlastRecipient.mockResolvedValue(1_432);
    counts.signingRequest.mockResolvedValue(340);
    counts.emailProviderAccount.mockResolvedValue(12);
    counts.conversationMessage.mockResolvedValue(2_050);
  });

  it('sums sends and rounds every stat down', async () => {
    const stats = await loadPublicStats();
    expect(stats.map((s) => [s.key, s.display])).toEqual([
      ['emailsSent', '6,400+'],
      ['repliesThreaded', '2,000+'],
      ['signaturesCollected', '340+'],
      ['mailboxesConnected', '12'],
    ]);
  });

  it('only counts SENT emails, SIGNED requests, CONNECTED mailboxes and inbound non-bounce messages', async () => {
    await loadPublicStats();
    expect(counts.emailJob).toHaveBeenCalledWith({ where: { status: 'SENT' } });
    expect(counts.recruiterBlastRecipient).toHaveBeenCalledWith({ where: { status: 'SENT' } });
    expect(counts.signingRequest).toHaveBeenCalledWith({ where: { status: 'SIGNED' } });
    expect(counts.emailProviderAccount).toHaveBeenCalledWith({ where: { status: 'CONNECTED' } });
    expect(counts.conversationMessage).toHaveBeenCalledWith({
      where: { direction: 'INBOUND', classification: { notIn: ['BOUNCE', 'DELIVERY_FAILURE'] } },
    });
  });

  it('hides a stat whose query fails instead of showing 0', async () => {
    counts.signingRequest.mockRejectedValue(new Error('boom'));
    const keys = (await loadPublicStats()).map((s) => s.key);
    expect(keys).not.toContain('signaturesCollected');
    expect(keys).toContain('emailsSent');
  });

  it('hides the email total when either half of it fails', async () => {
    counts.recruiterBlastRecipient.mockRejectedValue(new Error('boom'));
    const keys = (await loadPublicStats()).map((s) => s.key);
    expect(keys).not.toContain('emailsSent');
  });

  it('hides stats that are zero', async () => {
    counts.signingRequest.mockResolvedValue(0);
    const keys = (await loadPublicStats()).map((s) => s.key);
    expect(keys).not.toContain('signaturesCollected');
  });

  it('throws when every query fails (so it is not cached), and getPublicStats returns nothing', async () => {
    for (const fn of Object.values(counts)) fn.mockRejectedValue(new Error('down'));
    await expect(loadPublicStats()).rejects.toThrow();
    await expect(getPublicStats()).resolves.toEqual([]);
  });
});
