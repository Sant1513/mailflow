import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The open campaign page calls /drain repeatedly; an audit row per idle call grew the database for
 * nothing. Only passes that sent or failed something are logged.
 */
const db = { batch: { findUnique: vi.fn(async () => ({ status: 'RUNNING' })) } };
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const session = { userId: 'u1', organizationId: 'o1', workspaceId: 'w1', role: 'ADMIN', viewingAs: null };
vi.mock('@/lib/auth/session', () => ({ requireSession: vi.fn(async () => session) }));
vi.mock('@/lib/permissions/workspace', () => ({ requireCanWrite: vi.fn() }));
const audit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/audit/log', () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock('@/lib/campaigns/batchAccess', () => ({ loadBatchForSession: vi.fn(async () => ({ id: 'b1' })) }));
const runSendWorker = vi.fn();
vi.mock('@/lib/queue/sendWorker', () => ({ runSendWorker: (...a: unknown[]) => runSendWorker(...a), kickSendWorker: vi.fn() }));

const { POST } = await import('@/app/api/batches/[id]/drain/route');
const post = () => POST(new Request('http://localhost/api/batches/b1/drain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: 40 }) }) as any, { params: { id: 'b1' } } as any);

beforeEach(() => vi.clearAllMocks());

describe('POST /api/batches/[id]/drain audit', () => {
  it('logs a pass that sent emails', async () => {
    runSendWorker.mockResolvedValue({ sent: 3, failed: 0, remaining: 5, batches: 1, recovered: { markedSent: 0, requeued: 0 } });
    expect((await post()).status).toBe(200);
    expect(audit).toHaveBeenCalledWith(session, 'BATCH_DRAIN', expect.objectContaining({ targetId: 'b1' }));
  });

  it('logs a pass where emails failed', async () => {
    runSendWorker.mockResolvedValue({ sent: 0, failed: 1, remaining: 0, batches: 1, recovered: { markedSent: 0, requeued: 0 } });
    await post();
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for an idle or busy pass', async () => {
    runSendWorker.mockResolvedValue({ sent: 0, failed: 0, remaining: 5, batches: 0, busy: true, recovered: { markedSent: 0, requeued: 0 } });
    const j = await (await post()).json();
    expect(j.busy).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });
});
