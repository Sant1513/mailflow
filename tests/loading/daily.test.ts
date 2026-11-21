import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An in-memory stand-in for the shared SystemState row (the control database).
const state = { row: null as null | { loadingLines: unknown; loadingLinesTriedAt: Date | null } };
const db = {
  systemState: {
    findUnique: vi.fn(async () => (state.row ? { loadingLines: state.row.loadingLines } : null)),
    upsert: vi.fn(async () => { state.row ??= { loadingLines: null, loadingLinesTriedAt: null }; return state.row; }),
    updateMany: vi.fn(async ({ where, data }: { where: { OR: { loadingLinesTriedAt: null | { lt: Date } }[] }; data: { loadingLinesTriedAt: Date } }) => {
      const tried = state.row?.loadingLinesTriedAt ?? null;
      const free = tried === null || tried < (where.OR.find((o) => o.loadingLinesTriedAt && 'lt' in (o.loadingLinesTriedAt as object))?.loadingLinesTriedAt as { lt: Date }).lt;
      if (!state.row || !free) return { count: 0 };
      state.row.loadingLinesTriedAt = data.loadingLinesTriedAt;
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: { data: { loadingLines: unknown } }) => { state.row!.loadingLines = data.loadingLines; return state.row; }),
  },
};
vi.mock('@/lib/system/serverState', () => ({ controlDb: () => db }));

const generateText = vi.fn();
let provider: { generateText: typeof generateText } | null = { generateText };
vi.mock('@/lib/ai/service', () => ({ getAiProvider: () => provider }));

import { DAILY_PROMPT, getDailyLines, parseModelJson, resetDailyMemo } from '@/lib/loading/daily';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const answer = (extra: Record<string, unknown> = {}) => ({
  data: JSON.stringify({ inbox: ['Opening the inbox, again…', 'Fetching replies…'], general: ['Hello there'], thoughts: ['Be kind.'], ...extra }),
  usage: {},
});

beforeEach(() => {
  state.row = null;
  provider = { generateText };
  generateText.mockReset();
  generateText.mockResolvedValue(answer());
  Object.values(db.systemState).forEach((f) => f.mockClear());
  resetDailyMemo();
});
afterEach(() => vi.useRealTimers());

describe('getDailyLines: one AI call a day', () => {
  it('asks the AI once, stores the cleaned answer, and serves every later call from memory', async () => {
    const a = await getDailyLines(NOW);
    expect(a?.date).toBe('2026-11-20');
    expect(a?.pages.inbox).toEqual(['Opening the inbox, again…', 'Fetching replies…']);
    await getDailyLines(NOW + 1000);
    await getDailyLines(NOW + 60_000);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect((state.row!.loadingLines as { date: string }).date).toBe('2026-11-20');
  });
  it('another server (empty memory) reads the day’s lines from the shared row without asking the AI', async () => {
    await getDailyLines(NOW);
    resetDailyMemo(); // a different server instance
    const b = await getDailyLines(NOW + 5 * 3600_000);
    expect(b?.general).toEqual(['Hello there']);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
  it('asks again the next day', async () => {
    await getDailyLines(NOW);
    resetDailyMemo();
    state.row!.loadingLinesTriedAt = new Date(NOW - 20 * 3600_000); // yesterday's claim is old enough
    await getDailyLines(NOW + 24 * 3600_000);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it('two servers at once: only one asks, the other waits for the answer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    state.row = { loadingLines: null, loadingLinesTriedAt: new Date(NOW - 1000) }; // a server just claimed the call
    const waiting = getDailyLines(NOW);
    await vi.advanceTimersByTimeAsync(2000);
    state.row.loadingLines = { date: '2026-11-20', pages: {}, general: ['From the other server'], thoughts: [] };
    await vi.advanceTimersByTimeAsync(2000);
    expect((await waiting)?.general).toEqual(['From the other server']);
    expect(generateText).not.toHaveBeenCalled();
  });
  it('gives up quietly when the other server never answers', async () => {
    vi.useFakeTimers();
    state.row = { loadingLines: null, loadingLinesTriedAt: new Date(NOW - 1000) };
    const waiting = getDailyLines(NOW);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await waiting).toBeNull();
  });
  it('with no AI key: null, no error, no database write', async () => {
    provider = null;
    expect(await getDailyLines(NOW)).toBeNull();
    expect(db.systemState.update).not.toHaveBeenCalled();
  });
  it('when the AI fails or answers nonsense: null, nothing stored, retried only after 30 minutes', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    generateText.mockRejectedValueOnce(new Error('quota'));
    expect(await getDailyLines(NOW)).toBeNull();
    expect(state.row!.loadingLines).toBeNull();
    generateText.mockResolvedValueOnce({ data: 'sorry, I cannot', usage: {} });
    expect(await getDailyLines(NOW + 31 * 60_000)).toBeNull();
    expect(generateText).toHaveBeenCalledTimes(2);
    // Within 30 minutes of a try, nobody asks again (the claim is held).
    vi.useFakeTimers();
    const again = getDailyLines(NOW + 32 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await again).toBeNull();
    expect(generateText).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
  it('cleans what the model wrote before storing it: tags, links, long, repeated and non-text lines never reach anyone', async () => {
    generateText.mockResolvedValue(answer({
      inbox: ['<b>Nice</b> line', 'Visit https://evil.test', 'mail a@b.co', 'x'.repeat(200), 'Nice line', 7, null, 'Good one'],
      thoughts: ['javascript:alert(1)', 'A fine thought.'],
    }));
    const d = await getDailyLines(NOW);
    expect(d?.pages.inbox).toEqual(['Nice line', 'Good one']);
    expect(d?.thoughts).toEqual(['A fine thought.']);
  });
  it('wrapped in a code fence is fine', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('no json here')).toBeNull();
    expect(parseModelJson('{broken')).toBeNull();
  });
  it('the prompt is generic: no user, company or recruiter data and no addresses', () => {
    // It may say 'no "@"' as a rule, but it never carries an address, a link or a template variable.
    expect(DAILY_PROMPT).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+|https?:|\{\{/);
    expect(generateText).not.toHaveBeenCalled();
  });
  it('sends only that generic prompt to the model', async () => {
    await getDailyLines(NOW);
    expect(generateText.mock.calls[0]![0]).toBe(DAILY_PROMPT);
  });
});
