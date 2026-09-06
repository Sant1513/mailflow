import {
  AiError,
  type AIProvider,
  type AiResult,
  type AiUsageMeta,
  type CampaignDigestInput,
  type ConversationContext,
  type ConversationSummary,
  type Explanation,
  type GenerateEmailInput,
  type GeneratedEmail,
  type ImproveTextInput,
  type ImprovedText,
  type PersonalizationCheck,
  type PersonalizationCheckInput,
  type ReplyClassification,
  type ReplyStyle,
  type SubjectLinesInput,
  type SuggestedReply,
  REPLY_INTENTS,
} from '@/lib/ai/types';
import {
  SYSTEM_BASE,
  campaignSummaryPrompt,
  classifyPrompt,
  explainPrompt,
  generateEmailPrompt,
  improveTextPrompt,
  personalizationPrompt,
  subjectLinesPrompt,
  suggestReplyPrompt,
  summarizePrompt,
} from '@/lib/ai/prompts';

/**
 * §75/§82 GeminiProvider over the public Generative Language REST API.
 *
 * Deliberately no SDK: one fetch, a JSON response schema so every feature
 * returns typed data instead of prose to parse, an AbortController timeout,
 * and bounded retries with backoff for 429/5xx/network errors. A 429 that
 * survives the retries surfaces as AiError('RATE_LIMITED') so the UI can
 * say "AI usage limit reached — you can continue manually" (§82) rather
 * than failing the page.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /**
   * §82 fallback: models tried in order when the primary is rate-limited
   * (free-tier quotas are per model, so a sibling usually still answers).
   */
  fallbackModels?: string[];
  /** Injected for tests so retries do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Subset of Gemini's OpenAPI-style schema we use. */
export type GeminiSchema =
  | { type: 'STRING'; description?: string; enum?: string[] }
  | { type: 'NUMBER' | 'INTEGER' | 'BOOLEAN'; description?: string }
  | { type: 'ARRAY'; items: GeminiSchema; description?: string }
  | { type: 'OBJECT'; properties: Record<string, GeminiSchema>; required?: string[]; description?: string; nullable?: boolean };

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly fallbackModels: string[];

  constructor(opts: GeminiOptions) {
    if (!opts.apiKey) throw new AiError('NOT_CONFIGURED', 'GEMINI_API_KEY is not set');
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_GEMINI_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fallbackModels = (opts.fallbackModels ?? []).filter((m) => m && m !== this.model);
  }

  // ── transport ─────────────────────────────────────────────────────────

  /** Tries the primary model, then each fallback, moving on only when a model is rate-limited. */
  private async call(body: unknown): Promise<{ json: any; latencyMs: number; model: string }> {
    let lastError: AiError | null = null;
    for (const model of [this.model, ...this.fallbackModels]) {
      try {
        const r = await this.callModel(model, body);
        return { ...r, model };
      } catch (err) {
        if (err instanceof AiError && err.kind === 'RATE_LIMITED') {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new AiError('PROVIDER_ERROR', 'No model available');
  }

  private async callModel(model: string, body: unknown): Promise<{ json: any; latencyMs: number }> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const started = Date.now();
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const aborted = (err as any)?.name === 'AbortError';
        if (attempt < this.maxRetries) {
          attempt++;
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new AiError(aborted ? 'TIMEOUT' : 'PROVIDER_ERROR', aborted ? `Gemini timed out after ${this.timeoutMs}ms` : `Gemini unreachable: ${(err as Error).message}`, { retryable: true, cause: err });
      }
      clearTimeout(timer);

      if (res.ok) {
        const json = await res.json();
        return { json, latencyMs: Date.now() - started };
      }

      const text = await res.text().catch(() => '');
      let message = text.slice(0, 300);
      try {
        message = JSON.parse(text)?.error?.message ?? message;
      } catch {
        /* keep raw */
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoff(attempt));
        continue;
      }
      if (res.status === 429) {
        throw new AiError('RATE_LIMITED', 'Gemini quota exhausted (HTTP 429)', { status: 429, retryable: true });
      }
      if (res.status === 401 || res.status === 403) {
        throw new AiError('NOT_CONFIGURED', `Gemini rejected the API key (HTTP ${res.status}): ${message}`, { status: res.status });
      }
      throw new AiError('PROVIDER_ERROR', `Gemini error (HTTP ${res.status}): ${message}`, { status: res.status, retryable: RETRYABLE_STATUS.has(res.status) });
    }
  }

  private usage(json: any, latencyMs: number, model = this.model): AiUsageMeta {
    const u = json?.usageMetadata ?? {};
    return {
      provider: this.name,
      model,
      promptTokens: u.promptTokenCount ?? 0,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      totalTokens: u.totalTokenCount ?? 0,
      latencyMs,
    };
  }

  private extractText(json: any): string {
    const blocked = json?.promptFeedback?.blockReason;
    if (blocked) throw new AiError('SAFETY', `Gemini blocked the request (${blocked})`);
    const candidate = json?.candidates?.[0];
    if (!candidate) throw new AiError('BAD_RESPONSE', 'Gemini returned no candidates');
    if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
      throw new AiError('SAFETY', `Gemini stopped for ${candidate.finishReason}`);
    }
    const text = (candidate.content?.parts ?? [])
      .filter((p: any) => typeof p.text === 'string' && !p.thought)
      .map((p: any) => p.text)
      .join('');
    if (!text.trim()) throw new AiError('BAD_RESPONSE', `Gemini returned empty content (finishReason ${candidate.finishReason ?? 'unknown'})`);
    return text;
  }

  /** Structured call: the model must return JSON matching `schema`. */
  async structured<T>(prompt: string, schema: GeminiSchema, opts: { system?: string; maxOutputTokens?: number } = {}): Promise<AiResult<T>> {
    const { json, latencyMs, model } = await this.call({
      systemInstruction: { parts: [{ text: opts.system ?? SYSTEM_BASE }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.4,
        maxOutputTokens: opts.maxOutputTokens ?? 4096,
      },
    });
    const text = this.extractText(json);
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch (err) {
      throw new AiError('BAD_RESPONSE', 'Gemini returned malformed JSON', { cause: err });
    }
    return { data, usage: this.usage(json, latencyMs, model) };
  }

  // ── AIProvider ────────────────────────────────────────────────────────

  async generateText(prompt: string, opts: { system?: string; maxOutputTokens?: number } = {}): Promise<AiResult<string>> {
    const { json, latencyMs, model } = await this.call({
      systemInstruction: { parts: [{ text: opts.system ?? SYSTEM_BASE }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: opts.maxOutputTokens ?? 2048 },
    });
    return { data: this.extractText(json).trim(), usage: this.usage(json, latencyMs, model) };
  }

  async generateEmail(input: GenerateEmailInput): Promise<AiResult<GeneratedEmail>> {
    const r = await this.structured<GeneratedEmail>(generateEmailPrompt(input), {
      type: 'OBJECT',
      properties: {
        subject: { type: 'STRING' },
        previewText: { type: 'STRING' },
        plainText: { type: 'STRING' },
        html: { type: 'STRING' },
        usedVariables: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['subject', 'previewText', 'plainText', 'html', 'usedVariables'],
    });
    // Models sometimes echo names as {{Name}}; report bare names, only ones that exist.
    const used = Array.from(new Set((r.data.usedVariables ?? []).map((v) => String(v).replace(/[{}]/g, '').trim()).filter((v) => input.variables.includes(v))));
    return { data: { ...r.data, usedVariables: used }, usage: r.usage };
  }

  improveText(input: ImproveTextInput): Promise<AiResult<ImprovedText>> {
    return this.structured<ImprovedText>(improveTextPrompt(input), {
      type: 'OBJECT',
      properties: { text: { type: 'STRING' }, changes: { type: 'ARRAY', items: { type: 'STRING' } } },
      required: ['text', 'changes'],
    });
  }

  async subjectLines(input: SubjectLinesInput): Promise<AiResult<string[]>> {
    const r = await this.structured<{ subjects: string[] }>(subjectLinesPrompt(input), {
      type: 'OBJECT',
      properties: { subjects: { type: 'ARRAY', items: { type: 'STRING' } } },
      required: ['subjects'],
    });
    return { data: r.data.subjects, usage: r.usage };
  }

  checkPersonalization(input: PersonalizationCheckInput): Promise<AiResult<PersonalizationCheck>> {
    return this.structured<PersonalizationCheck>(personalizationPrompt(input), {
      type: 'OBJECT',
      properties: {
        score: { type: 'INTEGER' },
        findings: { type: 'ARRAY', items: { type: 'STRING' } },
        suggestions: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['score', 'findings', 'suggestions'],
    });
  }

  async summarizeConversation(ctx: ConversationContext): Promise<AiResult<ConversationSummary>> {
    const r = await this.structured<{ summary: string; suggestedNextAction: string; suggestedStatus: string }>(summarizePrompt(ctx), {
      type: 'OBJECT',
      properties: {
        summary: { type: 'STRING' },
        suggestedNextAction: { type: 'STRING' },
        suggestedStatus: { type: 'STRING', enum: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_STUDENT', 'RESOLVED', 'NONE'] },
      },
      required: ['summary', 'suggestedNextAction', 'suggestedStatus'],
    });
    const s = r.data.suggestedStatus;
    return {
      data: {
        summary: r.data.summary,
        suggestedNextAction: r.data.suggestedNextAction,
        suggestedStatus: s === 'OPEN' || s === 'IN_PROGRESS' || s === 'WAITING_FOR_STUDENT' || s === 'RESOLVED' ? s : null,
      },
      usage: r.usage,
    };
  }

  async classifyReply(ctx: ConversationContext): Promise<AiResult<ReplyClassification>> {
    const r = await this.structured<ReplyClassification>(classifyPrompt(ctx), {
      type: 'OBJECT',
      properties: {
        intent: { type: 'STRING', enum: [...REPLY_INTENTS] },
        confidence: { type: 'NUMBER' },
        reason: { type: 'STRING' },
      },
      required: ['intent', 'confidence', 'reason'],
    });
    const intent = REPLY_INTENTS.includes(r.data.intent) ? r.data.intent : 'UNKNOWN';
    const confidence = Math.min(1, Math.max(0, Number(r.data.confidence) || 0));
    return { data: { intent, confidence, reason: r.data.reason }, usage: r.usage };
  }

  suggestReply(ctx: ConversationContext, style: ReplyStyle = 'default'): Promise<AiResult<SuggestedReply>> {
    return this.structured<SuggestedReply>(suggestReplyPrompt(ctx, style), {
      type: 'OBJECT',
      properties: { text: { type: 'STRING' } },
      required: ['text'],
    });
  }

  summarizeCampaign(input: CampaignDigestInput): Promise<AiResult<Explanation>> {
    return this.structured<Explanation>(campaignSummaryPrompt(input), EXPLANATION_SCHEMA);
  }

  explain(question: string, facts: Record<string, unknown>): Promise<AiResult<Explanation>> {
    return this.structured<Explanation>(explainPrompt(question, facts), EXPLANATION_SCHEMA);
  }
}

const EXPLANATION_SCHEMA: GeminiSchema = {
  type: 'OBJECT',
  properties: { explanation: { type: 'STRING' }, nextSteps: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['explanation', 'nextSteps'],
};

function backoff(attempt: number): number {
  // 500ms, 1500ms, 3500ms … with a little jitter.
  return Math.min(500 * 2 ** attempt - 500, 8000) + Math.floor(Math.random() * 200);
}
