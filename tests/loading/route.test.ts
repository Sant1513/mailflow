import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireSession, getDailyLines, Unauthorized } = vi.hoisted(() => ({ requireSession: vi.fn(), getDailyLines: vi.fn(), Unauthorized: class extends Error {} }));
vi.mock('@/lib/auth/session', () => ({ requireSession, UnauthorizedError: Unauthorized, ForbiddenError: class extends Error {} }));
vi.mock('@/lib/loading/daily', () => ({ getDailyLines }));

import { GET } from '@/app/api/loading-lines/route';

beforeEach(() => {
  requireSession.mockReset().mockResolvedValue({ userId: 'u1' });
  getDailyLines.mockReset().mockResolvedValue({ date: '2026-11-20', pages: { inbox: ['One'] }, general: [], thoughts: [] });
});

describe('GET /api/loading-lines', () => {
  it('is for signed-in people only (401 otherwise, and the AI is not reached)', async () => {
    requireSession.mockRejectedValue(new Unauthorized('no'));
    const res = await GET(new Request('http://x/api/loading-lines'), {});
    expect(res.status).toBe(401);
    expect(getDailyLines).not.toHaveBeenCalled();
  });
  it('returns today’s lines, private and briefly cacheable', async () => {
    const res = await GET(new Request('http://x/api/loading-lines'), {});
    expect(res.status).toBe(200);
    expect((await res.json()).pages.inbox).toEqual(['One']);
    expect(res.headers.get('cache-control')).toContain('private');
  });
  it('says "empty" (200) when there are none, so the browser keeps the built-in lines', async () => {
    getDailyLines.mockResolvedValue(null);
    const body = await (await GET(new Request('http://x/api/loading-lines'), {})).json();
    expect(body.empty).toBe(true);
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
