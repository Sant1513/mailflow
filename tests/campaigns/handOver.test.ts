import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/gmail/oauth', () => ({ authorizedClientFor: vi.fn() }));
vi.mock('@/lib/app-url', () => ({ appBaseUrl: () => 'https://example.test' }));

import { handOverToSendWorker } from '@/lib/queue/sendWorker';

describe('hand-over to the next send worker', () => {
  beforeEach(() => { process.env.CRON_SECRET = 'x'; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete process.env.CRON_SECRET; });

  it('succeeds on the first call', async () => {
    const f = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', f);
    expect(await handOverToSendWorker('t')).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('tries again once when the first call fails fast, so the queue is not left idle', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', f);
    const p = handOverToSendWorker('t', { continuation: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await p).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[0]![0])).toContain('chain=1');
  });

  it('counts a deliberate hang-up as started', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: { signal: AbortSignal }) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))));
    const p = handOverToSendWorker('t');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await p).toBe(true);
  });

  it('gives up (false) after two failures', async () => {
    const f = vi.fn().mockResolvedValue({ status: 502 });
    vi.stubGlobal('fetch', f);
    const p = handOverToSendWorker('t');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await p).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
