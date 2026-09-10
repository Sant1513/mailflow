import { describe, it, expect } from 'vitest';
import { aiEnabledFromEnv, checkAiLimits, limitsFromEnv, startOfTodayIst } from '@/lib/ai/limits';

describe('limitsFromEnv (§82)', () => {
  it('defaults to 100 per user and 1000 per org', () => {
    expect(limitsFromEnv({})).toEqual({ userDaily: 100, orgDaily: 1000 });
  });

  it('reads positive integers and ignores junk', () => {
    expect(limitsFromEnv({ AI_USER_DAILY_LIMIT: '25', AI_ORG_DAILY_LIMIT: '400' })).toEqual({ userDaily: 25, orgDaily: 400 });
    expect(limitsFromEnv({ AI_USER_DAILY_LIMIT: '0', AI_ORG_DAILY_LIMIT: 'lots' })).toEqual({ userDaily: 100, orgDaily: 1000 });
    expect(limitsFromEnv({ AI_USER_DAILY_LIMIT: '-5', AI_ORG_DAILY_LIMIT: '2.5' })).toEqual({ userDaily: 100, orgDaily: 1000 });
  });
});

describe('aiEnabledFromEnv (§81)', () => {
  it('is on by default and off for false/0/off/no', () => {
    expect(aiEnabledFromEnv({})).toBe(true);
    expect(aiEnabledFromEnv({ AI_ENABLED: 'true' })).toBe(true);
    for (const v of ['false', 'FALSE', '0', 'off', 'no', ' false ']) expect(aiEnabledFromEnv({ AI_ENABLED: v })).toBe(false);
  });
});

describe('checkAiLimits', () => {
  const limits = { userDaily: 3, orgDaily: 5 };

  it('allows under both limits', () => {
    expect(checkAiLimits({ userToday: 2, orgToday: 4 }, limits)).toEqual({ allowed: true });
  });

  it('refuses at the user limit with the §82 wording', () => {
    const d = checkAiLimits({ userToday: 3, orgToday: 0 }, limits);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.scope).toBe('user');
      expect(d.message).toBe('AI usage limit reached (3 requests today). You can continue manually.');
    }
  });

  it('refuses at the org limit even when the user is under theirs', () => {
    const d = checkAiLimits({ userToday: 0, orgToday: 5 }, limits);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.scope).toBe('org');
  });
});

describe('startOfTodayIst', () => {
  it('is 18:30 UTC of the previous calendar day', () => {
    // 2026-09-05 06:30 UTC = 12:00 IST → IST day started 2026-09-04T18:30Z
    expect(startOfTodayIst(new Date('2026-09-05T06:30:00Z')).toISOString()).toBe('2026-09-04T18:30:00.000Z');
    // 2026-09-05 20:00 UTC = 01:30 IST on the 6th → day started 2026-09-05T18:30Z
    expect(startOfTodayIst(new Date('2026-09-05T20:00:00Z')).toISOString()).toBe('2026-09-05T18:30:00.000Z');
  });
});
