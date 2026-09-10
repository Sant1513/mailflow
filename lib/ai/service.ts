import { prisma } from '@/lib/db/client';
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from '@/lib/ai/gemini';
import { AiError, type AIProvider, type AiFeature, type AiResult, type AiUsageMeta } from '@/lib/ai/types';
import { aiEnabledFromEnv, checkAiLimits, limitsFromEnv, startOfTodayIst, type AiLimits, type EnvLike } from '@/lib/ai/limits';

/**
 * The one entry point the app uses to run an AI feature. It owns the
 * §81/§82 policy so no route can forget it:
 *   1. AI enabled?  2. provider configured?  3. per-user / per-org daily
 *   limit?  4. run with timeout+retry  5. log AiUsage — success or not
 *   6. map every failure to a graceful, non-throwing result.
 *
 * Callers get `{ ok: false, code, message }` and keep working; the AI
 * being unavailable never takes a page or a sync down (§82).
 */

export interface AiContext {
  userId: string;
  organizationId: string;
  workspaceId: string;
}

export type AiOutcome<T> =
  | { ok: true; data: T; usage: AiUsageMeta & { userToday: number; userLimit: number } }
  | { ok: false; code: 'DISABLED' | 'NOT_CONFIGURED' | 'LIMIT' | 'RATE_LIMITED' | 'TIMEOUT' | 'SAFETY' | 'ERROR'; message: string };

let cached: { key: string; provider: AIProvider } | null = null;

/** §82 fallback chain. Free-tier quotas are per model, so siblings keep the assistant alive. */
export const DEFAULT_FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];

export function fallbackModelsFromEnv(env: EnvLike = process.env): string[] {
  const raw = env.GEMINI_FALLBACK_MODELS;
  if (raw === undefined) return DEFAULT_FALLBACK_MODELS;
  return raw.split(',').map((m) => m.trim()).filter(Boolean);
}

/** GeminiProvider from the environment, or null when no key is set. Cached per key+model. */
export function getAiProvider(env: EnvLike = process.env): AIProvider | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const fallbackModels = fallbackModelsFromEnv(env).filter((m) => m !== model);
  const key = `${model}|${fallbackModels.join(',')}:${apiKey.slice(-6)}`;
  if (cached?.key !== key) cached = { key, provider: new GeminiProvider({ apiKey, model, fallbackModels }) };
  return cached.provider;
}

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
  provider: string | null;
  model: string | null;
  fallbackModels: string[];
  limits: AiLimits;
}

export function aiStatus(env: EnvLike = process.env): AiStatus {
  const provider = getAiProvider(env);
  return {
    enabled: aiEnabledFromEnv(env),
    configured: provider !== null,
    provider: provider?.name ?? null,
    model: provider?.model ?? null,
    fallbackModels: provider ? (provider as GeminiProvider).fallbackModels ?? [] : [],
    limits: limitsFromEnv(env),
  };
}

/** Calls that reached the provider today (limit-refused and disabled attempts excluded). */
export async function usageToday(ctx: Pick<AiContext, 'userId' | 'organizationId'>, now = new Date()) {
  const since = startOfTodayIst(now);
  // Prisma's notIn excludes NULLs (SQL semantics), and successful calls have a
  // null errorReason — so the null branch is spelled out or nothing would count.
  const counted = {
    createdAt: { gte: since },
    OR: [{ errorReason: null }, { errorReason: { notIn: ['LIMIT', 'DISABLED', 'NOT_CONFIGURED'] } }],
  };
  const [userToday, orgToday] = await Promise.all([
    prisma.aiUsage.count({ where: { userId: ctx.userId, ...counted } }),
    prisma.aiUsage.count({ where: { organizationId: ctx.organizationId, ...counted } }),
  ]);
  return { userToday, orgToday };
}

async function log(ctx: AiContext, feature: AiFeature, entry: { success: boolean; tokensUsed?: number; latencyMs?: number; errorReason?: string }) {
  try {
    await prisma.aiUsage.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        feature,
        success: entry.success,
        tokensUsed: entry.tokensUsed ?? null,
        latencyMs: entry.latencyMs ?? null,
        errorReason: entry.errorReason ? entry.errorReason.slice(0, 500) : null,
      },
    });
  } catch (err) {
    // Logging must never mask the actual result.
    console.error('[ai] usage log failed', err);
  }
}

export async function runAiFeature<T>(
  ctx: AiContext,
  feature: AiFeature,
  fn: (provider: AIProvider) => Promise<AiResult<T>>,
  deps: { env?: EnvLike; now?: Date } = {}
): Promise<AiOutcome<T>> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();

  if (!aiEnabledFromEnv(env)) {
    await log(ctx, feature, { success: false, errorReason: 'DISABLED' });
    return { ok: false, code: 'DISABLED', message: 'AI features are turned off for this deployment.' };
  }
  const provider = getAiProvider(env);
  if (!provider) {
    await log(ctx, feature, { success: false, errorReason: 'NOT_CONFIGURED' });
    return { ok: false, code: 'NOT_CONFIGURED', message: 'AI is not configured (GEMINI_API_KEY is missing).' };
  }

  const limits = limitsFromEnv(env);
  const counts = await usageToday(ctx, now);
  const decision = checkAiLimits(counts, limits);
  if (!decision.allowed) {
    await log(ctx, feature, { success: false, errorReason: 'LIMIT' });
    return { ok: false, code: 'LIMIT', message: decision.message };
  }

  try {
    const result = await fn(provider);
    await log(ctx, feature, { success: true, tokensUsed: result.usage.totalTokens, latencyMs: result.usage.latencyMs });
    return {
      ok: true,
      data: result.data,
      usage: { ...result.usage, userToday: counts.userToday + 1, userLimit: limits.userDaily },
    };
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError('PROVIDER_ERROR', (err as Error)?.message ?? 'Unknown AI error', { cause: err });
    await log(ctx, feature, { success: false, errorReason: `${e.kind}: ${e.message}` });
    console.error(`[ai] ${feature} failed: ${e.kind} ${e.message}`);
    switch (e.kind) {
      case 'RATE_LIMITED':
        return { ok: false, code: 'RATE_LIMITED', message: 'AI usage limit reached at the provider. You can continue manually and try again in a minute.' };
      case 'TIMEOUT':
        return { ok: false, code: 'TIMEOUT', message: 'The AI took too long to respond. You can continue manually or try again.' };
      case 'SAFETY':
        return { ok: false, code: 'SAFETY', message: 'The AI declined this request. You can continue manually.' };
      case 'NOT_CONFIGURED':
        return { ok: false, code: 'NOT_CONFIGURED', message: 'The AI provider rejected the configured key. An administrator needs to check GEMINI_API_KEY.' };
      default:
        return { ok: false, code: 'ERROR', message: 'The AI is unavailable right now. You can continue manually.' };
    }
  }
}
