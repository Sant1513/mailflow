/**
 * §82 AI rate limits — pure rules, configured from the environment.
 *
 *   AI_ENABLED             "false" switches every AI feature off (§81)
 *   AI_USER_DAILY_LIMIT    requests per user per day (default 100)
 *   AI_ORG_DAILY_LIMIT     requests per organisation per day (default 1000)
 *
 * Days roll over at midnight IST, the same reporting day as the analytics.
 * Only calls that reached the provider count — a request refused by these
 * limits never consumes quota, so a user cannot be locked out by their own
 * refused attempts.
 */

/** Plain string map so tests can pass partial environments. */
export type EnvLike = Record<string, string | undefined>;

export interface AiLimits {
  userDaily: number;
  orgDaily: number;
}

export function limitsFromEnv(env: EnvLike = process.env): AiLimits {
  return {
    userDaily: positiveInt(env.AI_USER_DAILY_LIMIT, 100),
    orgDaily: positiveInt(env.AI_ORG_DAILY_LIMIT, 1000),
  };
}

export function aiEnabledFromEnv(env: EnvLike = process.env): boolean {
  const raw = (env.AI_ENABLED ?? 'true').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface UsageCounts {
  userToday: number;
  orgToday: number;
}

export type LimitDecision = { allowed: true } | { allowed: false; scope: 'user' | 'org'; message: string };

/** The message is the exact §82 wording the UI shows. */
export function checkAiLimits(counts: UsageCounts, limits: AiLimits): LimitDecision {
  if (counts.userToday >= limits.userDaily) {
    return {
      allowed: false,
      scope: 'user',
      message: `AI usage limit reached (${limits.userDaily} requests today). You can continue manually.`,
    };
  }
  if (counts.orgToday >= limits.orgDaily) {
    return {
      allowed: false,
      scope: 'org',
      message: `The organisation's AI usage limit is reached (${limits.orgDaily} requests today). You can continue manually.`,
    };
  }
  return { allowed: true };
}

/** Start of the current IST day as a UTC instant, for "today" queries. */
export function startOfTodayIst(now = new Date()): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}
