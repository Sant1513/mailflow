import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiUsage: { count: vi.fn(), create: vi.fn() },
  },
}));

const { prisma } = await import('@/lib/db/client');
const { runAiFeature, aiStatus, getAiProvider } = await import('@/lib/ai/service');
const { AiError } = await import('@/lib/ai/types');

const ctx = { userId: 'u1', organizationId: 'org1', workspaceId: 'ws1' };
const env = { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'test-model', AI_USER_DAILY_LIMIT: '2', AI_ORG_DAILY_LIMIT: '10' };
const usage = { provider: 'gemini', model: 'test-model', promptTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 5 };

function counts(user: number, org: number) {
  (prisma.aiUsage.count as any).mockResolvedValueOnce(user).mockResolvedValueOnce(org);
}

describe('runAiFeature (§81/§82)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.aiUsage.create as any).mockResolvedValue({});
  });

  it('runs the feature, logs success with tokens, and reports usage', async () => {
    counts(0, 0);
    const r = await runAiFeature(ctx, 'suggest_reply', async () => ({ data: { text: 'hi' }, usage }), { env });
    expect(r).toMatchObject({ ok: true, data: { text: 'hi' }, usage: { totalTokens: 2, userToday: 1, userLimit: 2 } });
    expect(prisma.aiUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', organizationId: 'org1', workspaceId: 'ws1', feature: 'suggest_reply', success: true, tokensUsed: 2, latencyMs: 5, errorReason: null }),
    });
  });

  it('refuses when disabled, logs the attempt, and never calls the feature', async () => {
    const fn = vi.fn();
    const r = await runAiFeature(ctx, 'generate_email', fn, { env: { ...env, AI_ENABLED: 'false' } });
    expect(r).toMatchObject({ ok: false, code: 'DISABLED' });
    expect(fn).not.toHaveBeenCalled();
    expect(prisma.aiUsage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ success: false, errorReason: 'DISABLED' }) });
  });

  it('refuses when no key is configured', async () => {
    const r = await runAiFeature(ctx, 'generate_email', vi.fn(), { env: { AI_ENABLED: 'true' } });
    expect(r).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
  });

  it('refuses at the per-user limit with the §82 wording and does not consume quota', async () => {
    counts(2, 0);
    const fn = vi.fn();
    const r = await runAiFeature(ctx, 'improve_text', fn, { env });
    expect(r).toMatchObject({ ok: false, code: 'LIMIT', message: 'AI usage limit reached (2 requests today). You can continue manually.' });
    expect(fn).not.toHaveBeenCalled();
    expect(prisma.aiUsage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ success: false, errorReason: 'LIMIT' }) });
    // The count query must exclude refused attempts so they cannot lock a user out.
    const where = (prisma.aiUsage.count as any).mock.calls[0][0].where;
    expect(where.OR).toEqual([{ errorReason: null }, { errorReason: { notIn: expect.arrayContaining(['LIMIT', 'DISABLED']) } }]);
  });

  it('refuses at the org limit', async () => {
    counts(0, 10);
    const r = await runAiFeature(ctx, 'improve_text', vi.fn(), { env });
    expect(r).toMatchObject({ ok: false, code: 'LIMIT' });
    if (!r.ok) expect(r.message).toMatch(/organisation/);
  });

  it('maps provider rate limiting, timeouts and safety to graceful outcomes and logs the reason', async () => {
    for (const [kind, code] of [
      ['RATE_LIMITED', 'RATE_LIMITED'],
      ['TIMEOUT', 'TIMEOUT'],
      ['SAFETY', 'SAFETY'],
      ['BAD_RESPONSE', 'ERROR'],
      ['PROVIDER_ERROR', 'ERROR'],
    ] as const) {
      counts(0, 0);
      const r = await runAiFeature(ctx, 'summarize_conversation', async () => { throw new AiError(kind, 'boom'); }, { env });
      expect(r).toMatchObject({ ok: false, code });
      if (!r.ok) expect(r.message).toMatch(/continue manually|try again|administrator/);
      expect(prisma.aiUsage.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ success: false, errorReason: `${kind}: boom` }) });
    }
  });

  it('never throws even if the feature throws a plain error', async () => {
    counts(0, 0);
    const r = await runAiFeature(ctx, 'explain_send', async () => { throw new Error('unexpected'); }, { env });
    expect(r).toMatchObject({ ok: false, code: 'ERROR' });
  });

  it('keeps working when usage logging itself fails', async () => {
    counts(0, 0);
    (prisma.aiUsage.create as any).mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await runAiFeature(ctx, 'suggest_reply', async () => ({ data: { text: 'hi' }, usage }), { env });
    expect(r.ok).toBe(true);
    spy.mockRestore();
  });
});

describe('aiStatus / getAiProvider', () => {
  it('reports configured + model from env, and not configured without a key', () => {
    expect(aiStatus(env)).toMatchObject({ enabled: true, configured: true, provider: 'gemini', model: 'test-model', limits: { userDaily: 2, orgDaily: 10 } });
    expect(aiStatus({})).toMatchObject({ enabled: true, configured: false, provider: null, model: null });
    expect(getAiProvider({})).toBeNull();
  });

  it('caches the provider per key and model', () => {
    const a = getAiProvider(env);
    const b = getAiProvider(env);
    const c = getAiProvider({ ...env, GEMINI_MODEL: 'other' });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});
