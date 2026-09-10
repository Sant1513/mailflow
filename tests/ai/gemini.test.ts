import { describe, it, expect, vi } from 'vitest';
import { GeminiProvider } from '@/lib/ai/gemini';
import { AiError } from '@/lib/ai/types';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function ok(text: string, usage = { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20, totalTokenCount: 35 }) {
  return response(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage });
}

function provider(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {}) {
  return new GeminiProvider({ apiKey: 'k', model: 'test-model', fetchImpl, sleep: async () => undefined, ...extra });
}

describe('GeminiProvider transport (§82)', () => {
  it('refuses to construct without a key', () => {
    expect(() => new GeminiProvider({ apiKey: '' })).toThrow(AiError);
  });

  it('sends the key in a header, never in the URL, and parses structured JSON + usage', async () => {
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
      expect(String(url)).not.toContain('k');
      expect(init.headers['x-goog-api-key']).toBe('k');
      const body = JSON.parse(init.body);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.systemInstruction.parts[0].text).toContain('MailFlow');
      return ok(JSON.stringify({ text: 'hello', changes: ['x'] }));
    }) as any;
    const r = await provider(fetchImpl).improveText({ text: 'hi', mode: 'improve', format: 'text', variables: [] });
    expect(r.data).toEqual({ text: 'hello', changes: ['x'] });
    expect(r.usage).toMatchObject({ provider: 'gemini', model: 'test-model', promptTokens: 10, outputTokens: 25, totalTokens: 35 });
  });

  it('retries 503 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(503, { error: { message: 'busy' } }))
      .mockResolvedValueOnce(ok('"OK"')) as any;
    const r = await provider(fetchImpl).generateText('x');
    expect(r.data).toBe('"OK"');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After on 429 and maps exhaustion to RATE_LIMITED', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn().mockResolvedValue(response(429, { error: { message: 'quota' } }, { 'retry-after': '2' })) as any;
    await expect(provider(fetchImpl, { sleep, maxRetries: 2 }).generateText('x')).rejects.toMatchObject({ kind: 'RATE_LIMITED', opts: { status: 429 } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('does not retry 400/401/403 and reports NOT_CONFIGURED for auth failures', async () => {
    const bad = vi.fn().mockResolvedValue(response(403, { error: { message: 'API key not valid' } })) as any;
    await expect(provider(bad).generateText('x')).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
    expect(bad).toHaveBeenCalledTimes(1);

    const invalid = vi.fn().mockResolvedValue(response(400, { error: { message: 'bad schema' } })) as any;
    await expect(provider(invalid).generateText('x')).rejects.toMatchObject({ kind: 'PROVIDER_ERROR' });
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it('maps network failure after retries to PROVIDER_ERROR and an abort to TIMEOUT', async () => {
    const down = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as any;
    await expect(provider(down, { maxRetries: 1 }).generateText('x')).rejects.toMatchObject({ kind: 'PROVIDER_ERROR' });
    expect(down).toHaveBeenCalledTimes(2);

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const slow = vi.fn().mockRejectedValue(abort) as any;
    await expect(provider(slow, { maxRetries: 0 }).generateText('x')).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('surfaces safety blocks and malformed JSON as their own kinds', async () => {
    const blocked = vi.fn().mockResolvedValue(response(200, { promptFeedback: { blockReason: 'SAFETY' } })) as any;
    await expect(provider(blocked).generateText('x')).rejects.toMatchObject({ kind: 'SAFETY' });

    const garbage = vi.fn().mockResolvedValue(ok('not json')) as any;
    await expect(provider(garbage).summarizeCampaign({ name: 'c', status: 'COMPLETED', total: 1, sent: 1, failed: 0, skipped: 0, pending: 0, replies: 0, topErrors: [], topSkipReasons: [] })).rejects.toMatchObject({ kind: 'BAD_RESPONSE' });
  });

  it('ignores thought parts and clamps classification output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify({ intent: 'COMPLETED', confidence: 1.7, reason: 'said done' }) }] } }],
        usageMetadata: {},
      })
    ) as any;
    const r = await provider(fetchImpl).classifyReply({ recipientFirstName: 'R', senderName: 'S', subject: 's', messages: [] });
    expect(r.data).toEqual({ intent: 'COMPLETED', confidence: 1, reason: 'said done' });
  });

  it('falls back to the next model when the primary is rate-limited (§82)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: any) => {
      calls.push(String(url));
      return String(url).includes('primary') ? response(429, { error: { message: 'daily quota' } }) : ok('"OK"');
    }) as any;
    const p = provider(fetchImpl, { model: 'primary', fallbackModels: ['second', 'primary', 'third'], maxRetries: 0 });
    const r = await p.generateText('x');
    expect(r.data).toBe('"OK"');
    expect(r.usage.model).toBe('second');
    expect(calls.map((u) => u.match(/models\/([^:]+):/)?.[1])).toEqual(['primary', 'second']);
    expect(p.fallbackModels).toEqual(['second', 'third']);
  });

  it('does not fall back on non-quota errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(400, { error: { message: 'bad' } })) as any;
    await expect(provider(fetchImpl, { model: 'primary', fallbackModels: ['second'] }).generateText('x')).rejects.toMatchObject({ kind: 'PROVIDER_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('normalises an unknown suggested status to null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(JSON.stringify({ summary: 's', suggestedNextAction: 'a', suggestedStatus: 'NONE' }))) as any;
    const r = await provider(fetchImpl).summarizeConversation({ recipientFirstName: 'R', senderName: 'S', subject: 's', messages: [] });
    expect(r.data.suggestedStatus).toBeNull();
  });
});
